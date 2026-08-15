cmake_minimum_required(VERSION 3.20)
project(desktop_pet_process_loopback LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "windows-process-loopback can only be built on Windows")
endif()

add_executable(desktop-pet-process-loopback main.cpp)
target_compile_features(desktop-pet-process-loopback PRIVATE cxx_std_17)
target_compile_definitions(desktop-pet-process-loopback PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WIN32_WINNT=0x0A00
)
target_compile_options(desktop-pet-process-loopback PRIVATE /W4 /WX /EHsc)
target_link_libraries(desktop-pet-process-loopback PRIVATE ole32 avrt mmdevapi runtimeobject)
