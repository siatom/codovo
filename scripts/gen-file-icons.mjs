/**
 * 生成文件树图标要用的两份东西，都落在 `public/material-icons/` 下（不进仓库）：
 *
 *   mapping.json   文件名 / 扩展名 / 文件夹名 -> 图标 id
 *   <id>.svg       只拷真正会被引用到的图标
 *
 * 数据源是 devDependency `material-icon-theme`（MIT）。升级它之后重跑本脚本即可；
 * `dev` / `build` 前都会先跑一次，版本没变时直接退出。
 *
 * 为什么不直接用它的 dist/material-icons.json：
 *   - 那份有 451KB，里面大半是文件树用不上的段（languageIds、rootFolder*、语言 id…），
 *     而且里面的 iconPath 指到 node_modules，打包后取不到；
 *   - svg 有 3.3MB，全量塞进 bundle 不划算，所以拷到 public/ 让浏览器按需取。
 *
 * 图标 id 的展开态约定在这里断言（见 assertOpenConvention）：靠得住就可以不在
 * mapping.json 里再带一张 folderNamesExpanded 表，前端直接拼 `-open` 后缀。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 生成结果的格式版本。mapping.json 的结构或 svg 拷贝规则变了就 +1，好让 stamp 失效 */
const FORMAT = 1;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "material-icons");

/** 找 material-icon-theme 的包目录。拿 package.json 当锚点比拼路径稳（pnpm 会软链） */
let pkgJsonPath;
try {
  pkgJsonPath = createRequire(import.meta.url).resolve("material-icon-theme/package.json");
} catch {
  console.error("[gen-file-icons] 没找到 material-icon-theme，先跑一次 pnpm install");
  process.exit(1);
}
const pkgDir = dirname(pkgJsonPath);
const version = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;

const stamp = `${version}:${FORMAT}`;
const stampPath = join(outDir, ".stamp");
if (
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8").trim() === stamp &&
  existsSync(join(outDir, "mapping.json"))
) {
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(join(pkgDir, "dist", "material-icons.json"), "utf8"));

/** iconDefinitions 里的 iconPath 是相对 dist/ 的（`./../icons/x.svg`） */
function iconFileOf(id) {
  const def = manifest.iconDefinitions[id];
  if (!def) throw new Error(`material 里没有图标 id：${id}`);
  return join(pkgDir, "dist", def.iconPath);
}

/**
 * 展开态文件夹的 id 拼法：material 的 folderNamesExpanded 恒等于闭合态 id 加 `-open`，
 * 浅色变体则把 `_light` 后缀挪到末尾（folder-jinja_light -> folder-jinja-open_light）。
 * 前端 fileIcons.tsx 依赖这条约定，所以这里先按它算、再跟原始数据对一遍。
 */
function openIdOf(id) {
  return id.endsWith("_light") ? `${id.slice(0, -"_light".length)}-open_light` : `${id}-open`;
}

function assertOpenConvention(closed, expanded, label) {
  for (const [name, id] of Object.entries(closed)) {
    const want = openIdOf(id);
    if (expanded[name] !== want) {
      throw new Error(
        `${label} 的展开态不满足 "<id>-open" 约定：${name} -> ${expanded[name]}，期望 ${want}。\n` +
          "material-icon-theme 大概改了这套规则，需要同步改生成脚本和 src/components/fileIcons.tsx。",
      );
    }
  }
}

const light = manifest.light ?? {};
const lightFolderNames = light.folderNames ?? {};
assertOpenConvention(manifest.folderNames ?? {}, manifest.folderNamesExpanded ?? {}, "folderNames");
assertOpenConvention(lightFolderNames, light.folderNamesExpanded ?? {}, "light.folderNames");

/**
 * 每个键补一份小写别名：material 的 key 里有 `Dockerfile`、`CNAME`、`META-INF` 这类
 * 大小写敏感的写法，而文件树拿到的名字大小写不定（Windows/macOS 上尤其）。
 * 原样键排在前，查表时先精确命中、再退回小写（见 fileIcons.tsx 的 lookup）。
 */
function withAliases(map) {
  const out = { ...map };
  for (const [key, id] of Object.entries(map)) {
    const lower = key.toLowerCase();
    if (lower !== key && out[lower] === undefined) out[lower] = id;
  }
  return out;
}

// 真正会被引用到的图标：文件（按名 / 按扩展名）、文件夹（闭合 + 展开）、浅色覆盖项，外加兜底
const needed = new Set();
for (const id of Object.values(manifest.fileExtensions ?? {})) needed.add(id);
for (const id of Object.values(manifest.fileNames ?? {})) needed.add(id);
for (const id of Object.values(manifest.folderNames ?? {})) {
  needed.add(id);
  needed.add(openIdOf(id));
}
for (const id of Object.values(light.fileExtensions ?? {})) needed.add(id);
for (const id of Object.values(light.fileNames ?? {})) needed.add(id);
for (const id of Object.values(lightFolderNames)) {
  needed.add(id);
  needed.add(openIdOf(id));
}
needed.add(manifest.file);
needed.add(manifest.folder);
needed.add(manifest.folderExpanded);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const id of needed) cpSync(iconFileOf(id), join(outDir, `${id}.svg`));

writeFileSync(
  join(outDir, "mapping.json"),
  JSON.stringify({
    // 文件：先按整个文件名认（Dockerfile / package.json），再按扩展名
    fileNames: withAliases(manifest.fileNames ?? {}),
    fileExtensions: withAliases(manifest.fileExtensions ?? {}),
    // 文件夹：按目录名认（src / node_modules / .git）
    folderNames: withAliases(manifest.folderNames ?? {}),
    // 浅色主题的覆盖项，只有少数图标有；查不到就回落上面那三张表
    light: {
      fileNames: withAliases(light.fileNames ?? {}),
      fileExtensions: withAliases(light.fileExtensions ?? {}),
      folderNames: withAliases(lightFolderNames),
    },
    defaultFile: manifest.file,
    defaultFolder: manifest.folder,
  }),
);

writeFileSync(stampPath, stamp);
console.log(`[gen-file-icons] material-icon-theme ${version}：${needed.size} 个图标 + mapping.json`);
