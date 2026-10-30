export declare const SKILL_REFERENCES: string[];

export declare function skillVariables(input: {
  origin: string;
  version: string;
  kitFile: string;
  kitUrl?: string;
  kitSha256?: string;
  hosted?: boolean;
}): Record<string, string>;

export declare function renderSkill(source: string, values: Record<string, string>): string;
