# VRMA 动作资源

把 `.vrma`（VRM Animation）动作文件放到这个目录下，并在 `manifest.json` 里声明。

运行时用 `@pixiv/three-vrm-animation` 加载 `.vrma`，按 VRM 标准 humanoid 骨骼绑定到当前模型 ——
动作与模型解耦，**换 VRM 模型无需任何改动**，库负责骨骼归一化。

`manifest.json` 结构示例：

```json
[
  {
    "id": "dance",
    "label": "跳舞",
    "file": "hiphop.vrma",
    "loop": true,
    "fallback": "body"
  }
]
```

- `id`: 远程控制发送的动作名
- `label`: Web 控制台显示名
- `file`: 相对于 `pet/public/motions/` 的 `.vrma` 文件名
- `loop`: 是否循环播放
- `fallback`: 可选；`.vrma` 缺失或加载失败时回退到 `head` / `body` / `tail` 表情反应

## 怎么得到 .vrma

动作素材多为 Mixamo FBX，需要先转成 `.vrma`：

- **推荐：fbx2vrma-converter（CLI）** —— <https://github.com/tk256ailab/fbx2vrma-converter>
  内置 52 根 Mixamo→VRM 1.0 骨骼映射，`Walk.fbx → Walk.vrma`，适合批量。
- **Blender：VRM Addon for Blender** —— 手动导入 FBX 再导出 `.vrma`，控制更细，
  但要注意 **T-pose 对齐**（VRMA 规范要求动画基于 VRM T-pose，hips 的 y 分量不能塌成 0，
  否则在 VRM 工具里导入会失败 / 姿态错乱）。

从 [mixamo.com](https://www.mixamo.com) 下 FBX 时选 **FBX Binary**、**Without Skin**，
保持原始未经二次导出的文件，转换最稳。
