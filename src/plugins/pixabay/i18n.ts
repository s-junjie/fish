export interface PixabayPluginStrings {
  searchPlaceholder: string;
  searchAction: string;
  searching: string;
  noResults: string;
  inserted: string;
  filled: string;
  invalidKey: string;
  throttled: string;
  searchFailed: string;
  keyTitle: string;
  keyIntro: string;
  keyRisk: string;
  keyPlaceholder: string;
  keySave: string;
  keyClear: string;
  keySaved: string;
  keyCleared: string;
  keyLink: string;
  keySettings: string;
  keyBack: string;
}

const en: PixabayPluginStrings = {
  searchPlaceholder: "Search Pixabay photos...",
  searchAction: "Search",
  searching: "Searching Pixabay...",
  noResults: "No photos match your query",
  inserted: "Photo placed on canvas",
  filled: "Filled image into selected element",
  invalidKey: "Pixabay rejected this key — check it and try again",
  throttled: "Rate limit reached — wait a minute and try again",
  searchFailed: "Could not reach Pixabay",
  keyTitle: "Pixabay API key",
  keyIntro: "Pixabay needs a free API key. Yours stays in this browser and is never bundled with the plugin.",
  keyRisk:
    "Saved in localStorage only. Other plugins, and any local HTML file opened in this browser via file://, can read it. Pixabay also requires the key in the request URL, so it appears in network logs. Clear it here when you no longer need it.",
  keyPlaceholder: "Paste your Pixabay API key",
  keySave: "Save key",
  keyClear: "Clear key",
  keySaved: "API key saved",
  keyCleared: "API key cleared",
  keyLink: "Get a free API key",
  keySettings: "API key",
  keyBack: "Back"
};

const zh: PixabayPluginStrings = {
  searchPlaceholder: "搜索 Pixabay 图片...",
  searchAction: "搜索",
  searching: "正在搜索 Pixabay...",
  noResults: "没有匹配的图片",
  inserted: "图片已放置到画布",
  filled: "已填充到选中元素",
  invalidKey: "Pixabay 拒绝了此密钥，请检查后重试",
  throttled: "请求过于频繁，请稍后重试",
  searchFailed: "无法连接 Pixabay",
  keyTitle: "Pixabay API 密钥",
  keyIntro: "Pixabay 需要一个免费 API 密钥。它只保存在此浏览器中，不会随插件一起分发。",
  keyRisk:
    "密钥仅保存在 localStorage 中。同一浏览器里的其他插件、以及通过 file:// 打开的其他本地 HTML 文件都可能读到它；Pixabay 还要求把密钥放在请求 URL 里，因此它会出现在网络记录中。不再使用时请在这里清除。",
  keyPlaceholder: "粘贴你的 Pixabay API 密钥",
  keySave: "保存密钥",
  keyClear: "清除密钥",
  keySaved: "密钥已保存",
  keyCleared: "密钥已清除",
  keyLink: "获取免费 API 密钥",
  keySettings: "API 密钥",
  keyBack: "返回"
};

export function getStrings(locale: string = "en"): PixabayPluginStrings {
  return locale.toLowerCase().startsWith("zh") ? zh : en;
}
