export interface OpenversePluginStrings {
  searchPlaceholder: string;
  noResults: string;
  searching: string;
  inserted: string;
  filled: string;
  searchAction: string;
  licenceAny: string;
  licenceAnyTitle: string;
  licenceUnrestricted: string;
  licenceUnrestrictedTitle: string;
  licenceCommercial: string;
  licenceCommercialTitle: string;
  licenceRemixable: string;
  licenceRemixableTitle: string;
}

export const openverseStrings: OpenversePluginStrings = {
  searchPlaceholder: "Search photos (e.g. architecture, nature)...",
  noResults: "No photos match your query",
  searching: "Searching Openverse...",
  inserted: "Photo placed on canvas",
  filled: "Filled image into selected element",
  searchAction: "Search",
  licenceAny: "Any",
  licenceAnyTitle: "Every licence, including ones that forbid commercial use or edits",
  licenceUnrestricted: "CC0",
  licenceUnrestrictedTitle: "CC0 and public domain — no attribution, no restrictions",
  licenceCommercial: "Commercial",
  licenceCommercialTitle: "Commercial use allowed; adaptation rights may still be withheld",
  licenceRemixable: "Remix",
  licenceRemixableTitle: "Commercial use and adaptations both allowed, attribution may be required"
};
