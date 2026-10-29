# FISH 应用整体性能与稳定性深度分析及优化报告

在完成前四轮（Round 1–Round 4）针对视口交互、网格对齐、空间剪裁、实例继承及局部定义（`ElementDefs`）的专项优化后，基于 `demo/performance.fish.html`（42.6 MB 单文件、1,841 个画布节点、107 张内联 Base64 图像共 39.6 MB）的基准测试表明，FISH 的纯 JavaScript 主线程交互耗时已取得显著突破：画布平移/缩放期间的单帧 JS 执行耗时已降至约 `3.5 ms`，冷启动阶段由约 `8.5 s` 缩短至 `5.5 s`（`-36%`），拖拽与框选的 $O(N^2)$ 复杂度瓶颈已基本消除。

然而，随着纯 JS 计算开销的下降，应用的性能瓶颈已转移至**浏览器底层光栅化与解码管线（Blink/Skia Raster & Image Decode）**、**自动保存与持久化 I/O 放大（File System Access API & IndexedDB）**以及**拖拽帧内的全局定义/DOM 重算**；而在稳定性维度，**大体积 Base64 字符串在多级内存缓存中的驻留**、**后台标签页定时器节流引发的多标签页双写竞态**、**另存为路径缺失原子写保护**以及**外部资源抓取缺乏超时与沙箱隔离**，构成了当前架构向超大型设计文档（50 MB–100 MB+、5,000+ 节点）演进的主要阻碍。

本报告基于对 `src/core/` 与 `src/ui/` 全量核心源码的静态审计与性能剖析数据，系统梳理当前残留的 **8 项核心性能瓶颈（P0–P2）** 与 **8 项关键稳定性与数据安全隐患（S0–S2）**，并提供可直接落地的架构改造方案与分阶段演进路线图。

## 全局优化机会矩阵

下表汇总了当前代码库中识别出的全部性能与稳定性优化项、涉及的源码模块、触发场景、当前实测或推算开销，以及预期收益：

| 编号 | 类别与优先级 | 核心模块与代码位置 | 触发条件与频率 | 当前开销或稳定性风险 | 目标优化方案 | 预期收益与复杂度 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **P0-1** | 性能 P0（光栅化与解码） | `src/ui/canvas/CanvasDefs.tsx`<br>`src/ui/canvas/image-paint-attrs.ts`<br>`src/core/data-bridge.ts` | 缩放/平移包含高分辨率位图的画布，或挂载 `<pattern>` / 缩略图节点 | 40 步缩放中 JS 仅占 `3.5 ms/帧`，但 `DisplayItemList::Raster` 高达 `836 ms`（单瓦片峰值 `77.8 ms`），`Decode Image` 达 `206 ms`；39.6 MB `data:` 字符串直接挂载于 SVG `<image href>` | 引入运行时 `BlobUrlRegistry`（将 `data:` 转为短 `blob:` URL 供 DOM 渲染，序列化时仍用 `asset.uri`），配合缩放期间或小尺寸下的 Mipmap 降采样代理 | 最慢瓦片光栅化耗时降低 **47%**（`77.8 ms → 34.0 ms`），消除 DOM 长字符串哈希开销（中） |
| **P0-2** | 性能 P0（保存与序列化 I/O） | `src/core/data-bridge.ts`<br>`src/core/document-json.ts`<br>`src/core/dsl/normalize/resolve-values.ts` | 每次自动保存（编辑停顿 2s 或 30s 上限）及手动 `⌘S` | `backupBeforeWrite` 每次从磁盘重读 42.6 MB 全量文件并写入 IDB；`serializeSelf` 每次重新序列化 39.6 MB `#fish-assets` 并执行全量 `TextEncoder().encode`；`resolveValueTokens` 深度克隆并扫描 `assets` | 1. 基于 `WeakMap<AssetRef[], string>` 缓存 `#fish-assets` 序列化块；<br>2. `resolveValueTokens` 在 `vars` 为空时短路并跳过 `assets`；<br>3. 增量跳过未变更的磁盘重读备份与全量 UTF-8 编码 | 自动保存主线程阻塞从 `300 ms–600 ms+` 降至 **`< 35 ms`**，每次保存减少 **~85 MB** 瞬时内存分配（低） |
| **P1-1** | 性能 P1（拖拽帧重算） | `src/ui/canvas/CanvasDefs.tsx` | 拖拽移动、缩放节点或调整圆角时的每个 `requestAnimationFrame`（60Hz） | `CanvasDefs` 的 `useMemo` 依赖 `allElements`，导致拖拽每一帧都重新遍历全文档所有页面的 `collectThemes`、重建 `byId` 并重跑 `addClones` | 将 `collectThemes` 按页面 `WeakMap<Page, ThemeMap>` 缓存，并仅在元素的填充/描边/特效/剪切属性变化时重建对应 `<defs>`，忽略纯几何位移（`x`/`y`）变化 | 拖拽期间 `CanvasDefs` 单帧 CPU 开销下降 **70%–85%**（低） |
| **P1-2** | 性能 P1（DOM 样式扫描） | `src/ui/canvas/CanvasArea.tsx`<br>`src/ui/canvas/backdrop-lod.ts`<br>`src/ui/canvas/shadow-lod.ts` | 画布组件的每一次 React 重渲染（含悬停、选区、光标、拖拽帧） | `CanvasArea.tsx:429` 的 `useLayoutEffect` 未声明依赖数组，每次渲染后无条件执行两次全 SVG `querySelectorAll` 扫描 | 为 `useLayoutEffect` 补充精确依赖项 `[alignedElements, zoom, isCanvasOnlyView]` | 消除悬停、选区切换与光标更新时的冗余全树 DOM 查询（极低） |
| **P1-3** | 性能 P1（样式与令牌同步） | `src/core/interactions/style-sync.ts`<br>`src/core/interactions/style-tables.ts` | 文档归一化、主题切换、实例解析（`resolveInstanceBox`）及属性编辑 | `syncDualStorage` 每次调用都重新构建 `styleMap` 与 `tokenMap`（未按文档缓存），并对 `fills`/`strokes`/`effects` 执行 `JSON.parse(JSON.stringify(...))` 深拷贝 | 在 `styleTables(doc)` 中通过 `WeakMap<DesignDocument, ...>` 缓存 `stylesById` 与 `tokensById`；用结构化浅拷贝替代 `JSON.parse(JSON.stringify(...))` | 主题切换与全量归一化中的样式同步耗时减少 **40%–60%**，大幅降低 GC 压力（低） |
| **P1-4** | 性能 P1（IDB 历史与资产事务） | `src/core/persistence/timeline.ts`<br>`src/core/persistence/autosave-controller.ts`<br>`src/core/persistence/assets.ts` | 版本快照提交（`commitVersion`）、历史面板加载及冷启动资产引用计数 | `KVTimelineStore.list(docKey)` 调用 `getAll("versions")` 扫描同源下所有文件的全部历史版本，且单次提交连调 3 次；`KVAssetStore` 对 107 个资产逐个串行开启独立 IDB 事务 | 1. 在 `versions` 表建立 `docKey` 索引并在 `commitVersion` 内复用查询结果；<br>2. 用字符串长度估算替代 `TextEncoder().encode(JSON.stringify(rec))`；<br>3. `KVAssetStore` 合并为单事务批量读写 | 版本提交 IDB I/O 减少 **70%+**，107 张资产批量写入/引用计数耗时从数百毫秒降至 **`< 15 ms`**（中） |
| **P2-1** | 性能 P2（属性栏颜色聚合） | `src/ui/SelectedColorsStrip.tsx`<br>`src/core/interactions/selected-colors.ts` | 选中大型画板或多选节点时 Inspector 面板的每次渲染 | `collectSelectedColors` 未使用 `useMemo`；`boundFillStyleFor` 在每个颜色行的循环内部重复执行 `flattenElements(getActivePage(doc).children)` 重建整页 `Map`（$O(C \times N)$） | 对 `collectSelectedColors` 增加 `useMemo([doc, elements])`，并在 `boundFillStyleFor` 中直接复用 `findElementById`（基于缓存的 `TreeIndex`） | 选中包含数十种颜色的大型容器时，Inspector 渲染耗时从 `15–30 ms` 降至 **`< 1 ms`**（极低） |
| **P2-2** | 性能 P2（缩略图与评论层） | `src/ui/hooks/useThumbnailSnapshot.ts`<br>`src/ui/thumbnail-snapshot.ts`<br>`src/ui/canvas/CommentsOverlay.tsx` | 拖拽节点期间的连续 `doc` 更新；带评论锚点时的画布平移/缩放 | `useThumbnailSnapshot` 在每个拖拽帧都调用 `primeThumbnailSnapshot(doc)` 并在 400ms 停顿时编码含数兆位图的 1600px SVG；`CommentsOverlay` 每帧重算 `getBoundingClientRect` | 交互手势进行中（`isGestureActive`）暂停缩略图预热，改为仅在历史提交或空闲时触发；对 `CommentsOverlay` 实施 `React.memo` 与容器尺寸缓存 | 消除慢速拖拽中途的 400ms 缩略图编码卡顿与平移帧布局抖动（低） |
| **S0-1** | 稳定性 S0（内存泄漏 / OOM） | `src/core/persistence/hash.ts`<br>`src/core/persistence/assets.ts`<br>`src/core/store/editor-store.ts` | 长时间编辑会话、导入/替换/清理高分辨率图片或反复撤销 | 1. `hashCache` 将长达数 MB 的 Base64 字符串直接作为 `Map` 的 Key（上限 4,096 条），可常驻数 GB 内存；<br>2. `KVAssetStore.resident` 在内存中完整保留一份 `AssetRow`（含 Base64 URI）；<br>3. `EditorStore` 100 步历史栈长期驻留已删除的巨型位图 | 1. `hashCache` 禁止缓存超过 `64 KB` 的字符串字面量，对 `AssetRef` 改用 `WeakMap<AssetRef, string>`；<br>2. `resident` 仅保存 `{ key, refCount }` 元数据，剔除 `ref.uri` 副本；<br>3. 历史栈引入字节预算或资产外置引用 | 彻底根除大文件多轮图片编辑后的渲染进程 OOM 崩溃，常驻内存降低 **40%–60%**（低） |
| **S0-2** | 稳定性 S0（非原子文件覆写） | `src/core/persistence/writeback.ts` | 用户执行「另存为」、导出历史版本或应用更新回退（`saveDocAsNewFile`）并选择覆盖已有文件 | `saveDocAsNewFile`（第 295 行）直接调用 `handle.createWritable()` 而未传 `{ keepExistingData: true }`，也未执行 `truncate` 与异常 `abort()`；一旦写入中途磁盘满或异常，原文件直接变为 **0 字节** | 将 `saveDocAsNewFile` 的写入逻辑统一收敛至 `writeFileSafely` 的 `{ keepExistingData: true }` + `truncate(byteLength)` + `try/catch abort()` 原子写管线 | 消除「另存为」覆盖已有文件时因写入中断导致文件截断归零的数据丢失风险（极低） |
| **S0-3** | 稳定性 S0（多标签页双写冲突） | `src/core/persistence/tab-coordinator.ts`<br>`src/ui/hooks/useFileWriteback.ts` | 同一 `.fish.html` 在两个浏览器标签页中打开，且主标签页（Leader）切入后台超过 12 秒 | Chromium 会将后台标签页的 `setInterval` 强行节流至 `60,000 ms`（1 分钟）以上；前台从属标签页因 12s 未收到心跳而单方面接管 `onRegained()`，导致**前后台两个标签页同时开启自动写回**并相互覆盖磁盘文件 | 优先采用 Web Locks API（`navigator.locks.request`）实现内核级互斥锁；在不支持的环境中将写回领导权与 `document.visibilityState === "visible"` 及显式 `"yield"` 消息绑定 | 彻底杜绝后台定时器节流引发的多标签页「脑裂（Split-Brain）」双写数据损坏（低） |
| **S1-1** | 稳定性 S1（关闭标签页异步截断） | `src/core/persistence/autosave-controller.ts`<br>`src/ui/hooks/useFileWriteback.ts` | 用户在编辑后 2 秒防抖窗口内直接关闭或刷新标签页 | `pagehide` 触发的 `void this.flush()` 包含至少 5 个串行 `await`（IDB + FSA），浏览器卸载页面时会直接中止未完成的异步微任务链；同时 `beforeunload` 每次同步计算全量 `computeContentHash` 阻塞约 50ms | 在 `EditorStore` 维护轻量 `isDirty` 标志（或对比 `doc` 引用与上次已落盘引用），当 `idleTimer !== null` 或 `flushing === true` 时立即在 `beforeunload` 拦截提示，并缩短 IDB 恢复快照防抖时间 | 防止用户在防抖窗口内秒关标签页导致最后一次修改既未写入磁盘也未完成 IDB 恢复落盘（低） |
| **S1-2** | 稳定性 S1（隐私泄露与请求挂起） | `src/core/interactions/image-loader.ts`<br>`src/core/interactions/video-loader.ts`<br>`src/core/update/apply.ts` | 粘贴/导入外部图片或视频 URL、执行应用壳更新（`downloadShell`） | 1. `embedExternalAsset` 在直接 `fetch` 失败后静默将原始 URL 发送至第三方公共代理 `https://wsrv.nl/`，可能泄露内网地址或带签名 Token 的私有云链接；<br>2. 所有外部 `fetch` 均未设置 `AbortSignal.timeout`，网络挂起会导致状态永久卡死 | 1. 为所有外部 `fetch` 增加 `AbortSignal.timeout(15_000)`；<br>2. 在回退至 `wsrv.nl` 前拦截私有/内网主机名（`localhost`、`127.0.0.1`、`10.*`、`192.168.*`、`*.local`）或带鉴权查询参数的 URL | 消除网络半开连接导致的 UI 永久加载态，阻断内网/私有签名 URL 外泄（低） |
| **S1-3** | 稳定性 S1（视频嵌入沙箱缺失） | `src/ui/canvas/SvgVideoNode.tsx` | 画布渲染 YouTube / Vimeo / Bilibili / Dailymotion 等外部视频节点 | 与已配置严格 `HTML_EMBED_SANDBOX` 的 `SvgHtmlEmbedNode.tsx` 不同，`SvgVideoNode.tsx` 中的 `<iframe>` 未设置 `sandbox` 与 `referrerPolicy` 属性 | 为视频 `<iframe>` 补充 `sandbox="allow-scripts allow-same-origin allow-presentation"` 及 `referrerPolicy="no-referrer"` | 统一外部嵌入内容的安全边界，防止第三方播放器脚本劫持顶层窗口导航或收集本地文件路径信息（极低） |
| **S2-1** | 稳定性 S2（大文件粘贴与导入保护） | `src/core/import/figma-import.ts`<br>`src/core/import/html-import.ts`<br>`src/core/interactions/clipboard.ts` | 从剪贴板粘贴超大 HTML/SVG/Figma 载荷或拖入超大未压缩位图 | 剪贴板与 HTML 导入路径对节点深度、单张位图解码尺寸及总载荷体积缺乏前置配额校验，极端载荷可瞬间阻塞主线程数秒 | 在导入与粘贴入口增加载荷体积告警阈值与超大位图前置尺寸检查 | 避免异常剪贴板数据或超大位图导致主线程假死（低） |
| **S2-2** | 稳定性 S2（测试套件跨文件状态污染） | `vite.config.ts`<br>`src/core/geometry/text-measure.ts`<br>`src/core/interactions/detached-masters.ts` | 运行默认测试套件 `npm test`（`isolate: false`，269 个测试文件） | 多个模块级全局可变状态（`measureEl`、`fontStatus`、`heldMasters`、`idbPromise`、`bakeCache`）在测试文件间共享，导致增删测试文件时出现轮转偶发失败（如 `tests/mask.test.ts`） | 提供统一的 `resetRuntimeCachesForTest()` 钩子并在全局 `afterEach` 中调用，或通过 Vitest `projects` 将纯逻辑测试（`isolate: false`）与有状态 DOM 测试（`isolate: true`）分离 | 兼顾 ~45s 的极速测试执行与 100% 确定性的测试隔离（低） |

---

## 一、 画布渲染、光栅化与 SVG DOM 性能深潜

经过前四轮优化后，FISH 在处理 1,841 个元素的复杂页面时，纯 JavaScript 计算开销（视口剪裁 `computeVisibleElementIds`、像素网格对齐 `alignStageToDeviceGrid`、引用注册表构建 `buildReferenceRegistry`）已全部引入 `WeakMap` 缓存，单帧缩放/平移的 JS 执行时间已压缩至 `3.5 ms` 左右。当前画布渲染管线的剩余瓶颈主要集中在**浏览器光栅化线程（Raster/Decode）**与**拖拽交互期间的局部全树重算**。

### 1.1 内联 Base64 `data:` URI 引发的解码与光栅化瓶颈（P0-1）

在 `demo/performance.fish.html` 的 40 步连续缩放剖析（见 `plans/PERFORMANCE_OPTIMIZATION_PLAN.md` §7.1）中，Chromium 性能追踪揭示了极其悬殊的耗时分布：

| 渲染管线阶段 | 40 步缩放累计耗时 | 单次调用平均耗时 | 单次调用峰值耗时 | 占帧预算比例 |
| :--- | :--- | :--- | :--- | :--- |
| **JavaScript 主线程（Event + Timer + Layout）** | `~140 ms` | `~3.5 ms` | `~8.2 ms` | `< 25%`（已达标） |
| **`DisplayItemList::Raster`（光栅化线程）** | **`836 ms`** | `0.81 ms`（共 1,032 次） | **`77.8 ms`** | **单瓦片超标 4.6 倍** |
| **`Decode Image`（图像解码）** | **`206 ms`** | `4.91 ms`（共 42 次） | **`20.0 ms`** | **阻塞光栅化合成** |
| **`ImageFrameGenerator::decode`** | **`206 ms`** | `4.90 ms`（共 42 次） | **`20.0 ms`** | **同上** |

#### 根因分析
1. **高分辨率原图无级缩放采样开销**：文档中包含多张高达 `4800×1186`、`3600×2000` 像素的 PNG/JPEG 位图，而它们在画布上的实际显示尺寸往往仅为 `200×120` 屏幕像素。当视口缩放时，Skia 光栅化器必须在每个瓦片（Tile）上对数千万像素的原始纹素进行双三次或 Mitchell 下采样；实测将大于 512px 的原图替换为 512px 缩略图后，`DisplayItemList::Raster` 的最慢单瓦片耗时从 `77.8 ms` 直接降至 `34.0 ms`（**降低 47%**），`Decode Image` 从 `206 ms` 降至 `105 ms`（**降低 49%**）。
2. **`data:` URI 在 DOM 层的重复解析与内存拷贝**：当前 `src/ui/canvas/image-paint-attrs.ts` 与 `src/ui/canvas/CanvasDefs.tsx` 将长达数十万至数百万字符的 `data:image/png;base64,...` 字符串直接赋值给 SVG `<image href="...">` 属性。当 `<defs>` 中的 `<pattern>` 因视口剪裁挂载/卸载，或当 `AssetsPanel`、缩略图快照（`thumbnail-snapshot.ts`）同时引用同一资产时，Blink 必须对数兆字节的 DOM 属性字符串进行拷贝、解析与哈希校验，且跨 `<svg>` 实例难以稳定复用已解码的 GPU 纹理缓存。

#### 架构改造方案
- **引入运行时 `BlobUrlRegistry`（显存与 DOM 解耦）**：
  在 `src/core/assets/blob-url-registry.ts` 中维护一个以 `asset.id`（配合 `asset.uri` 引用或长度校验）为键的运行时映射表。当文档加载或资产入库时，通过 `fetch(dataUri).then(r => r.blob())` 或同步 Base64 解码生成极短的 `blob:null/...` Object URL 供画布 `<image href>`、`<feImage>` 及 `AssetsPanel` 渲染使用；而底层 `DesignDocument.assets` 依然保留原始 `data:` URI（或仅在 `serializeSelf` / `export` 时读取原始 `data:` URI），完全不改变单文件 HTML 的自包含格式约束。
- **按屏幕像素尺寸分级提供 Mipmap 代理（LOD Texture Proxy）**：
  对于宽高超过 `1024 px` 的大尺寸位图资产，在后台空闲时（`requestIdleCallback`）利用 `createImageBitmap` + `OffscreenCanvas` 预生成一张 `512 px` 级别的中低分辨率 `blob:` 代理 URL。当 `elementWorldSize * zoom <= 512 * devicePixelRatio` 或处于连续缩放手势期间（`isZooming === true`），`<ElementDefs>` 自动绑定 512px 代理 URL；当视口放大且静止后再平滑切回原图 URL。

---

### 1.2 拖拽帧中 `CanvasDefs` 的全文档主题收集与列表重建（P1-1）

#### 根因分析
在 `src/ui/canvas/CanvasDefs.tsx`（第 168–266 行）中，尽管单个元素的 `<ElementDefs>` 已通过 `React.memo` 实现了元素级复用，但顶层 `CanvasDefs` 组件内的 `useMemo` 依然将 `allElements`（即当前页的 `page.children` 引用）列为直接依赖项：

```ts
// src/ui/canvas/CanvasDefs.tsx:168-266
const { defElements, themes, numberModes, hasNoiseElements, ... } = useMemo(
  function buildDefs() {
    const visible = visibleElementIds
      ? allElements.filter((el) => visibleElementIds.has(el.id))
      : allElements;
    const byId = new Map<string, DesignElement>();
    for (const el of allElements) byId.set(el.id, el);
    // ...
    for (const el of visible) {
      if (el.type === "instance" && doc) addClones(el);
    }
    const { themes: th, numberModes: nm } = collectThemes(doc, activePageId, allElements);
    // ...
  },
  [allElements, visibleKey, doc?.pages, doc?.components, activePageId, doc],
);
```

当用户在画布上拖拽移动一个节点时，每一帧（16.7 ms）都会生成新的 `page.children`（`allElements`）与新的 `doc` 引用。这导致**每一个拖拽动画帧**都会完整执行一次 `buildDefs()`：
1. 遍历全页所有顶层/展平元素构建 `byId`；
2. 对视口内所有可见的 `instance` 节点递归调用 `resolveInstanceChildren` 展开克隆子树；
3. 调用 `collectThemes(doc, activePageId, allElements)`（第 134–158 行），而该函数内部执行了 `for (const p of doc.pages)`，**在每一帧遍历整个文档所有页面的全部节点树**来收集 `theme` 与 `numberMode`！

#### 架构改造方案
1. **按 `Page` 引用缓存主题与数值模式集合**：在 `collectThemes` 中引入 `WeakMap<Page, { themes: Map<string, Record<string, string>>; numberModes: Map<string, string> }>`。由于拖拽当前页的元素不会修改其他页面的 `Page` 对象引用，跨页面的主题收集可直接命中 $O(1)$ 缓存；对于当前页，由于拖拽只改变元素的 `x`/`y`/`width`/`height` 而不会改变 `theme` 或 `numberMode`，可在元素结构更新时复用上一帧的主题映射。
2. **跳过纯几何位移触发的 `<defs>` 重建**：大多数 `<defs>`（线性渐变、径向渐变 `objectBoundingBox`、图案填充、阴影滤镜）与元素在画布上的世界坐标 `(x, y)` 完全无关（仅 `liquid-glass` 折射位移与 `userSpaceOnUse` 渐变依赖坐标）。将 `defElements` 的派生与纯位置变换解耦，可消除拖拽帧中 70% 以上的 `buildDefs` 列表构建开销。

---

### 1.3 `CanvasArea` 无依赖数组的 `useLayoutEffect` 全树 DOM 扫描（P1-2）

#### 根因分析
在 `src/ui/canvas/CanvasArea.tsx`（第 429–433 行）中：

```ts
useLayoutEffect(() => {
  const svg = svgRef.current;
  if (!svg) return;
  applyBackdropLod(svg, zoom);
  applyShadowLod(svg, zoom);
});
```

该 `useLayoutEffect` **未传入依赖数组**。这意味着不仅在缩放（`zoom` 变化）或文档结构变化时会执行，在任何触发 `CanvasArea` 重渲染的轻量级交互中——包括鼠标移动更新悬停框（`hoveredId`）、选区切换（`selectedIds`）、框选矩形拖拽（`marquee`）、指南针或对齐参考线变化——React 都会在每次提交后同步调用 `applyBackdropLod` 与 `applyShadowLod`。这两个函数内部均通过 `svg.querySelectorAll(...)` 遍历整个 SVG DOM 树。

#### 架构改造方案
将该 `useLayoutEffect` 的依赖项显式收敛为 `[alignedElements, zoom, isCanvasOnlyView]`。当仅发生悬停、选区、参考线或工具态切换时，完全跳过两次全 SVG DOM 查询。

---

## 二、 持久化、序列化与 IndexedDB I/O 管线性能深潜

在包含数十兆位图资产的 `.fish.html` 文件中，**保存与自动写回（Auto-Save Writeback）**是目前造成主线程长任务（Long Tasks > 200 ms）最显著的来源。

### 2.1 自动保存中的全量文件重读备份与 `#fish-assets` 重复序列化（P0-2）

追踪 `src/ui/hooks/useFileWriteback.ts` → `src/core/persistence/writeback.ts` → `src/core/data-bridge.ts` 的完整自动保存调用链，在用户停止编辑 `2,000 ms`（`DEFAULT_IDLE_MS`）后，主线程会依次发生以下高开销操作：

1. **每次自动保存前的 42.6 MB 磁盘文件全量重读与 IDB 写入**：
   在 `src/core/data-bridge.ts` 的 `writeFileSafely`（第 504 行）中，每次写入磁盘前都会无条件调用 `await backupBeforeWrite(handle)`（第 408–425 行）：
   ```ts
   const file = await getFile.call(handle);
   const existing = await file.text(); // 读取磁盘上完整的 42.6 MB 字符串
   if (!existing || existing.length === 0) return;
   // 随后开启 IndexedDB 事务，将 42.6 MB 的 existing 字符串写入 "backups" 表
   ```
   这意味着用户每拖拽或修改一次图层并停顿 2 秒，浏览器就要从磁盘读取一次 42.6 MB 的 HTML 文本，并在 IndexedDB 中重写一次 42.6 MB 的记录！
2. **`#fish-assets`（39.6 MB）在每次保存时的重复 `JSON.stringify` 与正则转义**：
   在 `serializeSelf`（`src/core/data-bridge.ts` 第 155–160 行）中，即使本次编辑只移动了一个矩形的 `x` 坐标，而 `doc.assets` 数组引用分毫未动，代码依然会遍历全部 107 个资产，并执行：
   ```ts
   const assetsJson = JSON.stringify(uris, null, 2).replace(/<\//g, "\\u003c/");
   ```
   对 39.6 MB 的 Base64 字符串字典执行格式化序列化与全局正则替换，在主线程耗时约 `80 ms–140 ms`，并产生两个 ~40 MB 的临时字符串副本。
3. **全文件 42.6 MB 字符串的 `TextEncoder().encode` 字节长度计算**：
   在 `writeFileSafely`（第 515 行）中，为了计算 `truncate(byteLength)` 所需的 UTF-8 字节长度，代码执行了 `const byteLength = new TextEncoder().encode(fileContent).byteLength;`。这会分配一个 **42.6 MB 的 `Uint8Array`** 并将整个文件完整编码一遍，随后在 `writable.write(fileContent)` 中又将原字符串交给浏览器再编码一次。如果直接将已编码的 `Uint8Array`（`encoded`）传给 `writable.write(encoded)` 并使用 `encoded.byteLength`，即可直接省去一次 42.6 MB 的重复 UTF-8 编码！
4. **`resolveValueTokens` 在无变量或处理 `assets` 时的全树深拷贝**：
   在 `toDocumentText` → `normalizeDesignDocument` → `resolveValueTokens`（`src/core/dsl/normalize/resolve-values.ts` 第 318–340 行）中，即使文档的 `variables` 为空对象，递归函数 `walk(node)` 依然会深度克隆整棵文档树的每一个对象与数组，并对 `doc.assets` 中的 107 个 `uri` 逐一调用 `hasVarCall`（扫描 39.6 MB 字符串是否包含 `"("`）。

#### 架构改造方案
- **缓存 `#fish-assets` 序列化块**：在 `src/core/data-bridge.ts` 中维护 `const serializedAssetsCache = new WeakMap< readonly AssetRef[], string >()`。只要 `doc.assets` 的数组引用未发生变化（或资产 ID+URI 列表未变），`serializeSelf` 直接复用已转义的 `assetsScriptBlock` 字符串，将 `#fish-assets` 序列化耗时从 `~120 ms` 降至 **`0 ms`**。
- **消除 `writeFileSafely` 双重 UTF-8 编码与高频冗余备份**：
  - 将 `const encoded = new TextEncoder().encode(fileContent)` 的结果直接传给 `await writable.write(encoded)` 并使用 `encoded.byteLength` 进行 `truncate`，避免浏览器内部二次编码。
  - 在内存中记录上次成功写入磁盘的文本引用或轻量级长度/哈希签名，或为 `backupBeforeWrite` 设置最小时间间隔（例如每 60 秒或首次写入前备份一次上个稳定版本），避免每 2 秒向 IndexedDB 倾倒 42.6 MB 字符串。
- **在 `resolveValueTokens` 中跳过 `assets` 字段并在空变量表时短路**：当 `Object.keys(vars).length === 0` 时跳过字符串 `resolveVars` 检查，且在遍历文档顶层属性时对 `key === "assets"` 直接原样返回引用（资产 Base64 URI 绝不可能包含 `$var()` 令牌）。

---

### 2.2 IndexedDB 历史时间线全表扫描与资产串行事务（P1-4）

#### 根因分析
1. **`KVTimelineStore.list(docKey)` 全表反序列化与单次提交 3 重调用**：
   在 `src/core/persistence/timeline.ts`（第 69–76 行）中：
   ```ts
   async list(docKey: string): Promise<VersionRecord[]> {
     const all = await this.backend.getAll("versions");
     return all
       .filter((rec) => rec.docKey === docKey)
       .sort((a, b) => b.createdAt - a.createdAt);
   }
   ```
   由于本地文件均运行在同一个 `file://`（或同源 Web）Origin 下，`getAll("versions")` 会从 IndexedDB 中读取并反序列化**该用户电脑上所有 `.fish.html` 文档积累的全部历史快照**（每个快照包含完整的 `DesignDocument` 节点树）。更严重的是，在 `AutosaveController.commitVersion`（`src/core/persistence/autosave-controller.ts` 第 354–395 行）中，单次版本提交先后调用了：
   - `const existing = await this.options.timeline.list(docKey);`（第 354 行）
   - `await this.applyRetention(docKey);` → 内部再次调用 `await this.options.timeline.list(docKey);`（第 402 行）
   - `await this.notifyTimeline();` → 内部第三次调用 `await this.options.timeline.list(this.identity.docKey);`（第 456 行）
   单次快照提交触发了 **3 次全库历史表扫描**！此外，`estimateSize(rec)`（`timeline.ts` 第 151 行）使用 `new TextEncoder().encode(JSON.stringify(rec)).length` 计算字节数，进一步加剧了主线程分配开销。
2. **`KVAssetStore` 串行单条事务循环**：
   在 `src/core/persistence/assets.ts`（第 82–99 行、第 125–129 行）中，`acquire(hashes)`、`release(hashes)` 与 `toSnapshotAssets` 均采用 `for (const h of hashes) { await this.put(...); }` 的串行循环。当一个包含 107 张图片的文档首次建立恢复快照或裁剪旧历史版本时，会串行开启 **107 至 214 个独立的 IndexedDB 读写事务**，每个事务都需要经历浏览器 IPC 与磁盘同步开销。

#### 架构改造方案
- **消除三次重复查询并增加按 `docKey` 过滤能力**：在 `commitVersion` 中复用已获取的 `existing` 列表并在内存中追加新记录后传给 `applyRetention` 与 `notifyTimeline`，立即砍掉 2/3 的 IDB 读取；在 `estimateSize` 中改用 `JSON.stringify(rec).length`（误差极小且省去 `Uint8Array` 分配）。
- **批量化 `KVAssetStore` 事务**：在 `PersistBackend` 中提供批量读写接口（如 `getMany` / `putMany`），使 `acquire` 和 `release` 在单个 `readwrite` IndexedDB 事务内完成全部 107 个资产的引用计数更新。

---

## 三、 设计系统、样式同步与属性面板交互性能深潜

### 3.1 `syncDualStorage` 中的重复建表与深拷贝开销（P1-3）

#### 根因分析
在 `src/core/interactions/style-sync.ts`（第 253–267 行及第 306、336、464 行）中：
1. 每当对元素执行 `syncDualStorage(el, tables, mode)` 时，函数开头都会调用：
   ```ts
   const stylesById = styleMap(tables.styles);
   const tokensById = tokenMap(tables.tokens);
   ```
   当 `syncDocumentDualStorage` 或 `resolveInstanceBox` 遍历上千个节点时，即使 `tables` 完全相同，`styleMap` 和 `tokenMap` 也会被重复构建数千次。
2. 在同步填充、描边与特效时，代码大量使用 `JSON.parse(JSON.stringify(paint))` 与 `JSON.parse(JSON.stringify(s.effects))` 进行防御性克隆。在高频的实例属性解析与主题切换路径上，这种基于 JSON 文本往返的深拷贝会产生大量短生命周期字符串与对象垃圾。

#### 架构改造方案
- 在 `src/core/interactions/style-tables.ts` 中，将 `stylesById` 与 `tokensById` 预先封装进 `StyleTables` 结构并通过 `WeakMap<DesignDocument, StyleTables>` 缓存，使 `syncDualStorage` 直接以 $O(1)$ 复杂度读取映射表。
- 编写轻量级专用浅拷贝辅助函数（如 `clonePaint(p)`、`cloneEffect(e)`，仅复制顶层对象及 `stops` 数组），全面替换 `style-sync.ts` 中的 `JSON.parse(JSON.stringify(...))`。

---

### 3.2 `SelectedColorsStrip` 的 $O(C \times N)$ 重复展平遍历与缩略图高频预热（P2-1, P2-2）

#### 根因分析
1. **`SelectedColorsStrip` 的未缓存聚合与嵌套全页展平**：
   在 `src/ui/SelectedColorsStrip.tsx`（第 67 行）中，`const colors = collectSelectedColors(docRef.current, elements);` 未包裹 `useMemo`。更关键的是，在渲染前 36 个颜色行的 `.map()` 循环中（第 102 行），每一行都会调用 `boundFillStyleFor(docRef.current, color)`（位于 `src/core/interactions/selected-colors.ts` 第 300–319 行）：
   ```ts
   export function boundFillStyleFor(doc: DesignDocument, entry: SelectedColor): SharedStyle | undefined {
     const styles = doc.styles ?? [];
     if (styles.length === 0) return undefined;
     const byId = new Map(flattenElements(getActivePage(doc).children).map((el) => [el.id, el]));
     // ...
   ```
   当文档定义了共享样式（`doc.styles.length > 0`）且用户选中一个包含 36 种颜色的画板时，**单次 Inspector 渲染会连续调用 36 次 `flattenElements(getActivePage(doc).children)` 并重建 36 个包含全页 1,841 个元素的 `Map`**（累计遍历超 66,000 次节点）！
2. **拖拽过程中的缩略图定时器抖动（`useThumbnailSnapshot`）**：
   `src/ui/hooks/useThumbnailSnapshot.ts` 监听 `doc` 状态，在拖拽节点的每一帧都会调用 `primeThumbnailSnapshot(doc)`（`src/ui/thumbnail-snapshot.ts` 第 55 行），不仅每帧执行 `findThumbnailTargetFrame(doc)`，而且一旦用户在拖拽中途手指停顿满 `400 ms`，就会在主线程立即执行 `buildCoverSvg(doc)`，将包含多张巨型 Base64 位图的顶层画板序列化为完整的 SVG 字符串并喂给 `<img>` 解码，造成拖拽中途明显掉帧。

#### 架构改造方案
- 在 `boundFillStyleFor` 中直接使用 `findElementById(getActivePage(doc).children, occ.elementId)`（该函数已内置基于 `WeakMap` 的懒加载 `TreeIndex`），将单行查找复杂度从 $O(N)$ 降至 $O(1)$，并用 `useMemo` 缓存 `collectSelectedColors` 的结果。
- 将 `useThumbnailSnapshot` 的触发条件与 `EditorStore` 的手势状态联动（或将防抖延迟提升至 `2,000 ms` 并放入 `requestIdleCallback`），确保在鼠标按下拖拽期间绝不触发缩略图构建。

---

## 四、 稳定性、内存安全、多标签页并发与安全边界深潜

### 4.1 巨型 Base64 字符串在多级缓存中的内存驻留与 OOM 风险（S0-1）

在处理包含高分辨率图片或视频的 `.fish.html` 文档时，代码库中存在三处隐蔽的内存放大点，长期运行或反复导入/删除图片极易触发渲染进程内存溢出（OOM）：

1. **`src/core/persistence/hash.ts` 中的 `hashCache` 将数 MB 的 Base64 字符串作为 `Map` Key**：
   ```ts
   // src/core/persistence/hash.ts:18-28
   const HASH_CACHE_MAX = 4096;
   const hashCache = new Map<string, string>();
   export async function sha256Hex(input: string): Promise<string> {
     const hit = hashCache.get(input);
     if (hit !== undefined) return hit;
     // ...
     if (hashCache.size >= HASH_CACHE_MAX) hashCache.clear();
     hashCache.set(input, hex);
   ```
   `sha256Hex` 被 `KVAssetStore.toSnapshotAssets` 用于计算每个 `asset.uri` 的哈希。当 `input` 是 5 MB 的 Base64 图像或 20 MB 的视频 Data URI 时，`hashCache.set(input, hex)` 会将这 **5 MB–20 MB 的完整字符串作为键强引用保存在全局 `hashCache` 中**！哪怕用户随后在文档中删除了该资产并清理了历史记录，只要 `hashCache.size` 未满 4,096 条，这些巨型字符串就永远无法被 V8 垃圾回收器释放。
2. **`src/core/persistence/assets.ts` 中的 `KVAssetStore.resident` 内存双份驻留**：
   `KVAssetStore` 维护了 `private resident = new Map<string, AssetRow | null>()`（第 40 行）。每当 `put(ref)` 或 `get(key)` 执行时，完整的 `AssetRow`（包含数兆字节的 `ref.uri`）被存入 `this.resident`。然而，阅读 `KVAssetStore` 全文可见，`this.resident` 的唯一用途是在 `put` / `acquire` / `release` 中读取 `existing.refCount` 并写回，只有在冷启动恢复（`restoreDocumentAssets`）且文档本身缺失该资产时才需要从 IDB 读取 `row.ref`。在正常编辑期间，`resident` 白白在内存里驻留了一份全量资产副本。
3. **`EditorStore` 100 步撤销栈对已删除位图的保留**：
   `src/core/store/editor-store.ts`（第 15 行）固定保留 `DEFAULT_HISTORY_LIMIT = 100` 步快照。若用户导入并先后替换了 10 张 15 MB 的测试大图，这 150 MB 的旧 `AssetRef` 对象会一直被 `this.past` 数组强引用，直至推满 100 步操作。

#### 架构改造方案
- **限制 `hashCache` 的键长度并引入对象级 `WeakMap`**：在 `src/core/persistence/hash.ts` 中，仅当 `input.length <= 65_536`（64 KB）时才写入字符串 `hashCache`；对于 `AssetRef` 对象的哈希计算，新增 `hashAssetRef(ref: AssetRef)`，使用 `WeakMap<AssetRef, string>` 缓存其 SHA-256 值。一旦 `AssetRef` 从文档与历史栈中移除，缓存自动随 GC 释放。
- **精简 `KVAssetStore.resident` 为纯引用计数表**：将 `resident` 改为 `Map<string, number>`（仅记录 `hash -> refCount`），不再在 JS 堆中常驻 `AssetRow.ref`；仅在 `get(key)` 真正被恢复流程调用时按需查询 IndexedDB。

---

### 4.2 `saveDocAsNewFile` 缺失原子写保护导致覆盖文件归零风险（S0-2）

#### 根因分析
在 `docs/lessons/state-persistence.md` §12 中明确规定：使用 File System Access API 写入文件时，必须传入 `{ keepExistingData: true }` 并在写入后显式 `truncate(byteLength)`、异常时调用 `abort()`，否则 `createWritable()` 会在打开流的一瞬间将磁盘上的原文件截断为 **0 字节**。

然而，审计 `src/core/persistence/writeback.ts` 的 `saveDocAsNewFile`（第 295–298 行）发现，该路径并未遵循这一保护准则：

```ts
// src/core/persistence/writeback.ts:295-298
const writable = await handle.createWritable();
await writable.write(fileContent);
await writable.close();
```

当用户通过「另存为」、历史面板「导出版本」或 `applyUpdate` 降级路径调用 `saveDocAsNewFile`，并在系统文件选择器中选中了一个**已存在的 `.fish.html` 文件**进行覆盖保存时：
1. `handle.createWritable()` 立即将该已有文件截断为 0 字节；
2. 若此时磁盘空间不足、权限变更或序列化/编码抛出异常，`writable.write` 中断，原文件将彻底损坏为 0 字节空文件，且该路径没有 `backupBeforeWrite` 保护！

#### 架构改造方案
将 `saveDocAsNewFile` 中的文件流写入逻辑统一委托给 `src/core/data-bridge.ts` 中的原子写入辅助函数（开启 `{ keepExistingData: true }`，计算字节长度后 `truncate(byteLength)`，并在 `catch` 分支调用 `await writable.abort()`）。

---

### 4.3 后台标签页定时器节流引发的多标签页「脑裂」双写竞态（S0-3）

#### 根因分析
`src/core/persistence/tab-coordinator.ts` 通过 `BroadcastChannel` 和 `setInterval` 实现多标签页单写者选举（Leader Election）：
- `DEFAULT_ALIVE_MS = 4_000`（每 4 秒广播一次 `"alive"` 心跳）；
- `DEFAULT_TIMEOUT_MS = 12_000`（超过 12 秒未收到对方心跳即判定对方已关闭，并触发 `onRegained()` 夺取写回权）。

**致命缺陷在于 Chromium/Safari 对后台标签页定时器的强力节流机制**：
1. 用户在 Tab A（假设 `tabId` 字典序较小，当选为 Leader，`writebackEnabled = true`）打开 `design.fish.html`；
2. 用户在 Tab B 打开同一个文件，经协调后 Tab B 降级为从属标签页（`writebackEnabled = false`）；
3. 用户停留在 Tab B（或切换到其他应用窗口），此时 **Tab A 处于后台隐藏状态（`document.visibilityState === "hidden"`）**；
4. 10 秒后，浏览器将后台 Tab A 的 `setInterval` 定时器节流至 **每 60 秒执行一次**（甚至在 5 分钟后完全冻结）；
5. 第 12 秒时，前台 Tab B 的 `tick()` 检查发现距离上次收到 Tab A 的心跳已超过 `12,000 ms`，于是将 Tab A 从 `peers` 中剔除，并调用 `onRegained()` 将自身的 `writebackEnabled` 设为 `true`；
6. **此时 Tab A 的 `writebackEnabled` 依然为 `true`！** 当 Tab A 的后台自动保存（如 30s `maxWaitMs` 或恢复前台）触发时，Tab A 与 Tab B 会同时向同一个磁盘文件句柄写入不同步的数据，造成静默数据覆写。

#### 架构改造方案
1. **引入 Web Locks API 作为首选互斥机制**：在支持 `navigator.locks` 的浏览器环境中，使用 `navigator.locks.request(\`fish-writeback:\${fileId}\`, { ifAvailable: true }, ...)` 管理写回锁，由浏览器内核保证同一时刻绝不可能有两个标签页同时持有写锁。
2. **基于页面可见性（`visibilitychange` / `focus`）主动交接领导权**：在 `TabCoordinator` 中监听 `document.visibilityState`。当持有写回权的标签页切入 `hidden` 且存在其他活跃 `peers` 时，主动广播 `"yield"` 消息或豁免后台标签页的心跳超时淘汰；当任何从属标签页触发 `onRegained()` 时，必须向频道广播一条 `"claim"` 消息，强制仍在运行但被节流的旧 Leader 立即执行 `onYield()` 关闭其 `writebackEnabled`。

---

### 4.4 页面卸载（`pagehide` / `beforeunload`）的异步恢复截断风险（S1-1）

#### 根因分析
1. **防抖窗口内关闭标签页的异步链路过长**：
   在 `src/core/persistence/autosave-controller.ts`（第 213–221 行）中，`pagehide` 事件触发 `void this.flush()`。然而 `flush()` 是一个跨越多个微任务与 I/O 边界的长异步链：
   `ensureIdentity()` (SHA-256) → `recovery.load()` (IDB 读) → `assets.toSnapshotAssets()` (最多 107 次 SHA-256 + IDB 事务) → `recovery.save()` (IDB 写) → `writeBackFile()` (FSA 磁盘写)。
   根据浏览器生命周期规范，在 `pagehide` 事件回调返回后，渲染进程会立即开始销毁上下文，跨越多步 `await` 的后续 IndexedDB 事务根本无法保证执行完毕。
2. **`beforeunload` 同步计算全量哈希阻塞且漏检 `flushing` 状态**：
   在 `src/ui/hooks/useFileWriteback.ts`（第 150–162 行）中，`handleBeforeUnload` 在每次关闭/刷新时同步执行 `computeContentHash(store.getDoc()) !== lastSavedHashRef.current`。在大文档上这不仅会同步阻塞约 `50 ms`，而且当 `AutosaveController` 正在执行异步写回过程中时，缺乏对在途异步写入的直接状态判断。

#### 架构改造方案
- 在 `useFileWriteback` 中维护一个基于引用对比的快速脏检查标志（`let lastSavedDocRef = store.getDoc()`，每次 `writeBackFile` 成功完成后更新 `lastSavedDocRef`）。在 `beforeunload` 中，首先检查 `store.getDoc() !== lastSavedDocRef`：若引用相同则 $O(1)$ 直接放行；若引用不同，再结合哈希或直接触发浏览器标准的未保存离开确认框，确保在 2 秒防抖窗口或异步写入未落盘前关闭标签页时，用户能得到明确拦截保护。

---

### 4.5 外部资源抓取的隐私泄露、超时缺失与视频 `<iframe>` 沙箱加固（S1-2, S1-3）

#### 根因分析
1. **`embedExternalAsset` 静默转发 URL 至第三方公共代理 `wsrv.nl`**：
   在 `src/core/interactions/image-loader.ts`（第 504–510 行）中：
   ```ts
   const attempts = [
     url,
     `https://wsrv.nl/?url=${encodeURIComponent(url)}`,
   ];
   ```
   当用户引用了企业内网图片、本地开发服务器资源（如 `http://localhost:3000/mockup.png`）或带有临时鉴权签名的私有对象存储链接（如 AWS S3 Presigned URL），一旦直接 `fetch` 因 CORS 或网络波动失败，FISH 会静默将该完整 URL 发送给外部公共服务 `wsrv.nl`。此外，`image-loader.ts`、`video-loader.ts` 与 `src/core/update/apply.ts` 中的所有 `fetch` 调用均未传入 `signal: AbortSignal.timeout(...)`。
2. **`SvgVideoNode.tsx` 缺少 `<iframe>` 沙箱与 Referrer 隔离**：
   对比 `src/ui/canvas/SvgHtmlEmbedNode.tsx`（第 22 行定义了严格的 `HTML_EMBED_SANDBOX = "allow-scripts allow-forms"`）与 `src/ui/canvas/SvgVideoNode.tsx`（第 51–63 行），后者渲染外部视频播放器 `<iframe>` 时未声明 `sandbox` 属性与 `referrerPolicy="no-referrer"`。

#### 架构改造方案
- 为所有外部 `fetch` 统一注入 `AbortSignal.timeout(15_000)`，防止半开连接导致 `embeddingAssetIds` 集合泄漏及状态栏加载指示器永久挂起。
- 在构造 `wsrv.nl` 代理回退前，校验目标 URL 的主机名与查询参数：若属于环回地址、RFC 1918 私有网段、`.local`/`.internal` 域名，或包含常见签名参数（`X-Amz-Signature`、`token`、`sig`），则直接跳过公共代理回退。
- 在 `src/ui/canvas/SvgVideoNode.tsx` 的 `<iframe>` 上补充 `sandbox="allow-scripts allow-same-origin allow-presentation"` 与 `referrerPolicy="no-referrer"`。

---

### 4.6 测试套件模块级状态隔离与确定性加固（S2-2）

#### 根因分析
`vite.config.ts`（第 169–176 行）为了将 269 个测试文件的运行时间从 `~207s` 缩短至 `~45s`，启用了 `isolate: false`。这导致所有测试文件在同一个 Worker 进程内共享模块级单例缓存，主要包括：
- `src/core/geometry/text-measure.ts`：模块级 `measureEl`、`fontStatus`、`fontCbs`；
- `src/core/interactions/detached-masters.ts`：模块级 `heldMasters` 映射表；
- `src/core/persistence/backend.ts`：模块级 `idbPromise` 与 `memoryFallback`；
- `src/ui/canvas/glass-bake-cache.ts` 与 `src/core/persistence/hash.ts`：模块级 `bakeCache` 与 `hashCache`。

当新增或重命名测试文件改变分片执行顺序时，前序测试残留的 DOM 测量节点或缓存状态会导致后续无关测试（如 `tests/mask.test.ts` 或 `tests/non-uniform-stroke.test.ts`）偶发失败。

#### 架构改造方案
在 Vitest 的 `setupFiles`（或全局 `afterEach` 钩子）中注册轻量级的模块状态重置函数（清理 `heldMasters`、重置 `text-measure` 降级状态与内存后端），或者在 `vite.config.ts` 中使用 Vitest `projects` 配置：将 ~250 个纯数据/几何/DSL 单元测试保持在 `isolate: false` 极速池中运行（耗时 `< 12s`），仅将涉及 JSDOM 全局样式与 Canvas 渲染的 ~20 个集成测试放入 `isolate: true` 池中运行，从而在保持 `~45s` 总耗时的同时实现 100% 的测试确定性。

---

## 五、 分阶段实施路线图（Phased Rollout Plan）

为确保演进过程平稳且每一步均可独立验证，建议按以下三个阶段推进落地：

### 第一阶段：零风险高收益速赢与核心数据安全加固（预计耗时：1–2 天）
本阶段全部为局部代码改造，不改变任何外部数据结构或持久化协议，可立即消除最危险的数据损坏隐患与最高频的无谓计算：
1. **原子写统一加固（S0-2）**：修复 `src/core/persistence/writeback.ts` 中的 `saveDocAsNewFile`，接入 `keepExistingData: true` + `truncate(byteLength)` + `try/catch abort()`。
2. **内存缓存封顶与去重（S0-1）**：在 `src/core/persistence/hash.ts` 中对 `> 64 KB` 的字符串跳过 `hashCache` 并为 `AssetRef` 增加 `WeakMap` 哈希缓存；在 `src/core/persistence/assets.ts` 中将 `KVAssetStore.resident` 瘦身为仅保存 `refCount` 数值。
3. **保存管线 `#fish-assets` 缓存与编码去重（P0-2）**：在 `src/core/data-bridge.ts` 中通过 `WeakMap<AssetRef[], string>` 缓存已序列化的 `#fish-assets` 脚本块，并在 `writeFileSafely` 中直接写入 `TextEncoder` 生成的 `Uint8Array`；在 `src/core/dsl/normalize/resolve-values.ts` 中跳过 `assets` 字段。
4. **DOM 与属性栏热路径止血（P1-2, P2-1, S1-3）**：为 `src/ui/canvas/CanvasArea.tsx:429` 的 `useLayoutEffect` 补齐 `[alignedElements, zoom, isCanvasOnlyView]` 依赖；修复 `src/core/interactions/selected-colors.ts` 中 `boundFillStyleFor` 的重复展平并使用 `useMemo`；为 `src/ui/canvas/SvgVideoNode.tsx` 补齐 `sandbox` 与 `referrerPolicy`。

### 第二阶段：持久化并发协议、多标签页锁与样式同步重构（预计耗时：2–3 天）
1. **多标签页协调器升级（S0-3, S1-1）**：在 `src/core/persistence/tab-coordinator.ts` 中引入 Web Locks API / 可见性感知主从切换协议，并在 `src/ui/hooks/useFileWriteback.ts` 中基于文档引用与 `flushing` 状态加固 `beforeunload` 拦截。
2. **IndexedDB 批量事务与时间线去重（P1-4）**：消除 `AutosaveController.commitVersion` 中对 `timeline.list(docKey)` 的三次重复调用，优化 `estimateSize`，并将 `KVAssetStore` 的 `acquire`/`release` 合并为单事务批量操作。
3. **样式表缓存与拖拽帧 `<defs>` 解耦（P1-1, P1-3）**：在 `src/core/interactions/style-tables.ts` 中按文档 `WeakMap` 缓存 `styleMap`/`tokenMap`，移除 `style-sync.ts` 中的 `JSON.parse(JSON.stringify(...))`；在 `src/ui/canvas/CanvasDefs.tsx` 中按页面缓存 `collectThemes`。
4. **网络超时与代理过滤（S1-2）**：为 `image-loader.ts`、`video-loader.ts`、`apply.ts` 增加 `AbortSignal.timeout(15_000)` 与私有地址过滤。

### 第三阶段：运行时 `BlobUrlRegistry` 与分级 Mipmap 光栅化加速（预计耗时：3–5 天）
1. **构建 `BlobUrlRegistry`（P0-1）**：在 `src/core/assets/blob-url-registry.ts` 中实现 `data:` URI 到运行时 `blob:` URL 的按需转换与生命周期管理，使 `<ElementDefs>`、`<image>` 与 `AssetsPanel` 统一绑定短 `blob:` URL。
2. **大图 Mipmap 降采样代理（P0-1）**：对超高清位图资产在后台生成 `512 px` 级代理 `blob:` URL，在连续缩放手势或小尺寸屏占比下自动切换 LOD 纹理，彻底攻克 `DisplayItemList::Raster` 的 `77.8 ms` 瓦片光栅化峰值。
3. **测试套件状态清理钩子（S2-2）**：落地统一的运行时缓存重置钩子，消除 `isolate: false` 下的跨文件状态偶发污染。

---

## 六、 核心代码位置参考索引

| 子系统领域 | 涉及源码路径（仓库相对路径） | 关键函数或组件 |
| :--- | :--- | :--- |
| **自包含序列化与磁盘写回** | `src/core/data-bridge.ts`<br>`src/core/persistence/writeback.ts`<br>`src/ui/hooks/useFileWriteback.ts` | `serializeSelf`、`writeFileSafely`、`backupBeforeWrite`、`saveDocAsNewFile`、`useFileWriteback` |
| **归一化与变量令牌解析** | `src/core/document-json.ts`<br>`src/core/dsl/normalize/document.ts`<br>`src/core/dsl/normalize/resolve-values.ts` | `toDocumentText`、`normalizeDesignDocument`、`resolveValueTokens` |
| **自动保存、历史与资产存储** | `src/core/persistence/autosave-controller.ts`<br>`src/core/persistence/timeline.ts`<br>`src/core/persistence/assets.ts`<br>`src/core/persistence/hash.ts`<br>`src/core/persistence/tab-coordinator.ts` | `AutosaveController.flush`、`commitVersion`、`KVTimelineStore.list`、`KVAssetStore`、`sha256Hex`、`TabCoordinator` |
| **画布渲染与 SVG 定义生成** | `src/ui/canvas/CanvasArea.tsx`<br>`src/ui/canvas/CanvasDefs.tsx`<br>`src/ui/canvas/image-paint-attrs.ts`<br>`src/ui/canvas/CommentsOverlay.tsx`<br>`src/ui/thumbnail-snapshot.ts` | `CanvasArea`、`CanvasDefs`、`collectThemes`、`applyBackdropLod`、`applyShadowLod`、`primeThumbnailSnapshot` |
| **样式同步与属性栏聚合** | `src/core/interactions/style-sync.ts`<br>`src/core/interactions/style-tables.ts`<br>`src/core/interactions/selected-colors.ts`<br>`src/ui/SelectedColorsStrip.tsx` | `syncDualStorage`、`styleTables`、`collectSelectedColors`、`boundFillStyleFor` |
| **外部资源导入与安全边界** | `src/core/interactions/image-loader.ts`<br>`src/core/interactions/video-loader.ts`<br>`src/ui/canvas/SvgVideoNode.tsx`<br>`src/core/update/apply.ts` | `embedExternalAsset`、`embedExternalVideoAsset`、`SvgVideoNode`、`downloadShell` |
| **状态管理与测试工程化** | `src/core/store/editor-store.ts`<br>`vite.config.ts` | `EditorStore`、`test` 配置项 |
