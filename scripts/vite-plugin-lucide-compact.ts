import type { Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function findFiles(dir: string): string[] {
  const res: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      res.push(...findFiles(full));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      res.push(full);
    }
  }
  return res;
}

export function lucideCompactPlugin(): Plugin {
  const VIRTUAL_ID = "\0virtual:lucide-react";
  const lucidePkgPath = path.resolve(process.cwd(), "node_modules/lucide-react");
  const indexSrc = fs.readFileSync(path.join(lucidePkgPath, "dist/esm/lucide-react.mjs"), "utf-8");
  const exportMap = new Map<string, string>();

  for (const line of indexSrc.split("\n")) {
    const m = line.match(/export\s*\{([^}]+)\}\s*from\s*["']\.\/icons\/([^"']+)["']/);
    if (m) {
      const file = m[2];
      const names = m[1].split(",").map((s) => {
        const parts = s.trim().split(/\s+as\s+/);
        return parts[1] || parts[0];
      });
      for (const n of names) {
        exportMap.set(n.trim(), file);
      }
    }
  }

  function getUsedIcons(): Set<string> {
    const icons = new Set<string>();
    const srcDir = path.resolve(process.cwd(), "src");
    for (const file of findFiles(srcDir)) {
      const content = fs.readFileSync(file, "utf-8");
      if (!content.includes("lucide-react")) continue;
      const matches = content.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide-react["']/g);
      for (const m of matches) {
        m[1]
          .split(",")
          .map((s) => s.trim().replace(/^type\s+/, ""))
          .forEach((i) => {
            if (i) {
              const parts = i.split(/\s+as\s+/);
              icons.add(parts[0].trim());
            }
          });
      }
    }
    return icons;
  }

  return {
    name: "fish-lucide-compact",
    enforce: "pre",
    resolveId(id) {
      if (id === "lucide-react") return VIRTUAL_ID;
    },
    async load(id) {
      if (id !== VIRTUAL_ID) return null;
      const icons = getUsedIcons();
      let code = `import { createElement as h } from "preact";\n\n`;
      code += `function createIcon(nodes) {\n`;
      code += `  return function Icon({ size = 24, width, height, color = "currentColor", strokeWidth = 2, className, style, children, ...rest }) {\n`;
      code += `    return h("svg", {\n`;
      code += `      xmlns: "http://www.w3.org/2000/svg",\n`;
      code += `      width: width ?? size,\n`;
      code += `      height: height ?? size,\n`;
      code += `      viewBox: "0 0 24 24",\n`;
      code += `      fill: "none",\n`;
      code += `      stroke: color,\n`;
      code += `      strokeWidth,\n`;
      code += `      strokeLinecap: "round",\n`;
      code += `      strokeLinejoin: "round",\n`;
      code += `      className,\n`;
      code += `      style,\n`;
      code += `      ...rest\n`;
      code += `    }, nodes.map(([tag, attrs], i) => h(tag, { ...attrs, key: i })), children);\n`;
      code += `  };\n`;
      code += `}\n\n`;

      for (const icon of Array.from(icons).sort()) {
        const file = exportMap.get(icon);
        if (!file) {
          throw new Error(`[lucide-compact] Icon "${icon}" not found in lucide-react exports`);
        }
        const fileUrl = pathToFileURL(path.join(lucidePkgPath, "dist/esm/icons", file)).href;
        const mod = await import(fileUrl);
        const nodes = (mod.__iconData?.node || []).map(([tag, attrs]: [string, any]) => {
          const cleanAttrs = { ...attrs };
          delete cleanAttrs.key;
          return [tag, cleanAttrs];
        });
        code += `export const ${icon} = createIcon(${JSON.stringify(nodes)});\n`;
      }
      return code;
    },
    handleHotUpdate({ file, server }) {
      if (file.endsWith(".tsx") || file.endsWith(".ts")) {
        const mod = server.moduleGraph.getModuleById(VIRTUAL_ID);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
        }
      }
    }
  };
}
