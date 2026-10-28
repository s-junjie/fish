export interface WikimediaPluginStrings {
  searchPlaceholder: string;
  noResults: string;
  searching: string;
  inserted: string;
  filled: string;
  searchAction: string;
  searchFailed: string;
  throttled: string;
}

const en: WikimediaPluginStrings = {
  searchPlaceholder: "Search Commons photos (e.g. architecture, nature)...",
  noResults: "No photos match your query",
  searching: "Searching Wikimedia Commons...",
  inserted: "Photo placed on canvas",
  filled: "Filled image into selected element",
  searchAction: "Search",
  searchFailed: "Could not reach Wikimedia Commons",
  throttled: "Too many requests — wait a moment and try again"
};

const zh: WikimediaPluginStrings = {
  searchPlaceholder: "搜索维基共享资源图片（例如建筑、自然）...",
  noResults: "没有匹配的图片",
  searching: "正在搜索维基共享资源...",
  inserted: "图片已放置到画布",
  filled: "已填充到选中元素",
  searchAction: "搜索",
  searchFailed: "无法连接维基共享资源",
  throttled: "请求过于频繁，请稍后重试"
};

export function getStrings(locale: string = "en"): WikimediaPluginStrings {
  return locale.toLowerCase().startsWith("zh") ? zh : en;
}
