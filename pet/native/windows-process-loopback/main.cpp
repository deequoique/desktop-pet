#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <wrl.h>
#include <wrl/implements.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {

constexpr uint32_t kMagic = 0x4c415044;  // "DPAL", little endian.
constexpr uint16_t kProtocolVersion = 1;
constexpr uint16_t kFrameTypePcm = 1;
constexpr uint32_t kSampleRate = 48000;
constexpr uint16_t kChannels = 2;
constexpr uint16_t kBitsPerSample = 16;
constexpr uint32_t kFrameMs = 20;
constexpr size_t kFrameBytes = kSampleRate * kFrameMs / 1000 * kChannels * (kBitsPerSample / 8);
constexpr size_t kMaxQueuedFrames = 50;

#pragma pack(push, 1)
struct FrameHeader {
  uint32_t magic;
  uint16_t version;
  uint16_t type;
  uint64_t sequence;
  uint64_t pts_ms;
  uint32_t payload_length;
  uint32_t flags;
};
#pragma pack(pop)
static_assert(sizeof(FrameHeader) == 32, "frame header layout must stay stable");

struct PcmFrame {
  uint64_t sequence = 0;
  uint64_t pts_ms = 0;
  uint32_t flags = 0;
  std::array<uint8_t, kFrameBytes> pcm{};
};

void WriteStatus(const char* code, uint64_t dropped_frames = 0) {
  char message[256]{};
  const int length = dropped_frames
      ? std::snprintf(message, sizeof(message), "{\"code\":\"%s\",\"droppedFrames\":%llu}\n",
                      code, static_cast<unsigned long long>(dropped_frames))
      : std::snprintf(message, sizeof(message), "{\"code\":\"%s\"}\n", code);
  if (length <= 0) return;
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_ERROR_HANDLE), message,
            static_cast<DWORD>((std::min)(length, static_cast<int>(sizeof(message) - 1))), &written, nullptr);
}

bool WriteAll(HANDLE output, const void* data, size_t length) {
  const auto* cursor = static_cast<const uint8_t*>(data);
  while (length > 0) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>((std::min)(length, static_cast<size_t>(64 * 1024)));
    if (!WriteFile(output, cursor, chunk, &written, nullptr) || written == 0) return false;
    cursor += written;
    length -= written;
  }
  return true;
}

class ActivationHandler final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  explicit ActivationHandler(HANDLE completed) : completed_(completed) {}

  ~ActivationHandler() {
    if (completed_) CloseHandle(completed_);
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activation_result = E_FAIL;
    ComPtr<IUnknown> activated;
    const HRESULT operation_result = operation->GetActivateResult(&activation_result, &activated);
    result_ = FAILED(operation_result) ? operation_result : activation_result;
    if (SUCCEEDED(result_)) result_ = activated.As(&audio_client_);
    SetEvent(completed_);
    return S_OK;
  }

  HRESULT result() const { return result_; }
  ComPtr<IAudioClient> audio_client() const { return audio_client_; }

 private:
  HANDLE completed_ = nullptr;
  HRESULT result_ = E_PENDING;
  ComPtr<IAudioClient> audio_client_;
};

struct Arguments {
  DWORD exclude_pid = 0;
};

bool ParseUnsigned(const wchar_t* text, unsigned long* value) {
  if (!text || !*text) return false;
  wchar_t* end = nullptr;
  const unsigned long parsed = std::wcstoul(text, &end, 10);
  if (!end || *end != L'\0') return false;
  *value = parsed;
  return true;
}

bool ParseArguments(int argc, wchar_t** argv, Arguments* result) {
  if (argc != 9) return false;
  unsigned long pid = 0;
  unsigned long sample_rate = 0;
  unsigned long channels = 0;
  unsigned long frame_ms = 0;
  if (std::wstring(argv[1]) != L"--exclude-pid" || !ParseUnsigned(argv[2], &pid) || pid == 0
      || std::wstring(argv[3]) != L"--sample-rate" || !ParseUnsigned(argv[4], &sample_rate)
      || std::wstring(argv[5]) != L"--channels" || !ParseUnsigned(argv[6], &channels)
      || std::wstring(argv[7]) != L"--frame-ms" || !ParseUnsigned(argv[8], &frame_ms)) return false;
  if (sample_rate != kSampleRate || channels != kChannels || frame_ms != kFrameMs) return false;
  result->exclude_pid = static_cast<DWORD>(pid);
  return true;
}

class FrameQueue {
 public:
  void Push(PcmFrame frame) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (frames_.size() >= kMaxQueuedFrames) {
      frames_.pop_front();
      ++dropped_frames_;
      if (dropped_frames_ == 1 || dropped_frames_ % 50 == 0) WriteStatus("frames_dropped", dropped_frames_);
    }
    frames_.push_back(std::move(frame));
    condition_.notify_one();
  }

  bool Pop(PcmFrame* frame) {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [this] { return stopping_ || !frames_.empty(); });
    if (frames_.empty()) return false;
    *frame = std::move(frames_.front());
    frames_.pop_front();
    return true;
  }

  void Stop() {
    std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
    condition_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<PcmFrame> frames_;
  uint64_t dropped_frames_ = 0;
  bool stopping_ = false;
};

HRESULT ActivateProcessLoopback(DWORD exclude_pid, ComPtr<IAudioClient>* result) {
  HANDLE completed = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!completed) return HRESULT_FROM_WIN32(GetLastError());
  auto handler = Microsoft::WRL::Make<ActivationHandler>(completed);
  if (!handler) {
    CloseHandle(completed);
    return E_OUTOFMEMORY;
  }

  AUDIOCLIENT_ACTIVATION_PARAMS activation_params{};
  activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activation_params.ProcessLoopbackParams.TargetProcessId = exclude_pid;
  activation_params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activate_params;
  PropVariantInit(&activate_params);
  activate_params.vt = VT_BLOB;
  activate_params.blob.cbSize = sizeof(activation_params);
  activate_params.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  const HRESULT activate_call = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activate_params,
      handler.Get(),
      &operation);
  if (FAILED(activate_call)) return activate_call;
  const DWORD wait_result = WaitForSingleObject(completed, 10'000);
  if (wait_result != WAIT_OBJECT_0) return wait_result == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT) : E_FAIL;
  if (FAILED(handler->result())) return handler->result();
  *result = handler->audio_client();
  return *result ? S_OK : E_NOINTERFACE;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  Arguments args;
  if (!ParseArguments(argc, argv, &args)) {
    WriteStatus("invalid_arguments");
    return 2;
  }
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    WriteStatus("com_initialization_failed");
    return 3;
  }

  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, args.exclude_pid);
  HANDLE stop_event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE audio_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!parent || !stop_event || !audio_event) {
    WriteStatus("handle_initialization_failed");
    if (parent) CloseHandle(parent);
    if (stop_event) CloseHandle(stop_event);
    if (audio_event) CloseHandle(audio_event);
    CoUninitialize();
    return 4;
  }

  ComPtr<IAudioClient> audio_client;
  HRESULT result = ActivateProcessLoopback(args.exclude_pid, &audio_client);
  if (FAILED(result)) {
    WriteStatus("activation_failed");
    CloseHandle(parent);
    CloseHandle(stop_event);
    CloseHandle(audio_event);
    CoUninitialize();
    return 5;
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = kBitsPerSample;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  result = audio_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
          | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      0,
      0,
      &format,
      nullptr);
  if (FAILED(result) || FAILED(audio_client->SetEventHandle(audio_event))) {
    WriteStatus("audio_client_initialization_failed");
    audio_client.Reset();
    CloseHandle(parent);
    CloseHandle(stop_event);
    CloseHandle(audio_event);
    CoUninitialize();
    return 6;
  }

  ComPtr<IAudioCaptureClient> capture_client;
  if (FAILED(audio_client->GetService(IID_PPV_ARGS(&capture_client)))) {
    WriteStatus("capture_client_unavailable");
    audio_client.Reset();
    CloseHandle(parent);
    CloseHandle(stop_event);
    CloseHandle(audio_event);
    CoUninitialize();
    return 7;
  }

  FrameQueue queue;
  std::thread writer([&queue, stop_event] {
    DWORD task_index = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &task_index);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    PcmFrame frame;
    while (queue.Pop(&frame)) {
      const FrameHeader header{
          kMagic, kProtocolVersion, kFrameTypePcm, frame.sequence, frame.pts_ms,
          static_cast<uint32_t>(frame.pcm.size()), frame.flags};
      if (!WriteAll(output, &header, sizeof(header)) || !WriteAll(output, frame.pcm.data(), frame.pcm.size())) {
        WriteStatus("stdout_closed");
        SetEvent(stop_event);
        break;
      }
    }
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  });

  std::thread stdin_monitor([stop_event] {
    uint8_t command = 0;
    DWORD read = 0;
    ReadFile(GetStdHandle(STD_INPUT_HANDLE), &command, 1, &read, nullptr);
    SetEvent(stop_event);
  });

  if (FAILED(audio_client->Start())) {
    WriteStatus("capture_start_failed");
    SetEvent(stop_event);
  } else {
    WriteStatus("capture_started");
  }

  std::vector<uint8_t> accumulator;
  accumulator.reserve(kFrameBytes * 2);
  uint64_t sequence = 0;
  HANDLE waits[] = {stop_event, parent, audio_event};
  bool running = true;
  while (running) {
    const DWORD wait_result = WaitForMultipleObjects(3, waits, FALSE, INFINITE);
    if (wait_result == WAIT_OBJECT_0 || wait_result == WAIT_OBJECT_0 + 1 || wait_result == WAIT_FAILED) break;
    if (wait_result != WAIT_OBJECT_0 + 2) continue;
    while (running) {
      UINT32 packet_frames = 0;
      if (FAILED(capture_client->GetNextPacketSize(&packet_frames))) {
        WriteStatus("capture_packet_query_failed");
        running = false;
        break;
      }
      if (packet_frames == 0) break;
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture_client->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
        WriteStatus("capture_buffer_failed");
        running = false;
        break;
      }
      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      const size_t offset = accumulator.size();
      accumulator.resize(offset + bytes);
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || !data) {
        std::fill(accumulator.begin() + static_cast<std::ptrdiff_t>(offset), accumulator.end(), 0);
      } else {
        std::copy(data, data + bytes, accumulator.begin() + static_cast<std::ptrdiff_t>(offset));
      }
      if (FAILED(capture_client->ReleaseBuffer(frames))) {
        WriteStatus("capture_buffer_release_failed");
        running = false;
        break;
      }
      while (accumulator.size() >= kFrameBytes) {
        PcmFrame frame;
        frame.sequence = sequence++;
        frame.pts_ms = GetTickCount64();
        std::copy_n(accumulator.begin(), kFrameBytes, frame.pcm.begin());
        accumulator.erase(accumulator.begin(), accumulator.begin() + static_cast<std::ptrdiff_t>(kFrameBytes));
        queue.Push(std::move(frame));
      }
    }
  }

  audio_client->Stop();
  queue.Stop();
  if (writer.joinable()) writer.join();
  // Unblock a still-pending stdin read during parent-process termination.
  CancelSynchronousIo(stdin_monitor.native_handle());
  if (stdin_monitor.joinable()) stdin_monitor.join();
  WriteStatus("capture_stopped");
  capture_client.Reset();
  audio_client.Reset();
  CloseHandle(parent);
  CloseHandle(stop_event);
  CloseHandle(audio_event);
  CoUninitialize();
  return 0;
}
