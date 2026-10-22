/**
 * 文档翻译分段的最小回归测试（项目没有前端测试框架，用 Vite 的 SSR 加载直接跑）。
 *
 *   node scripts/test-translate-split.mjs
 *
 * 重点验证超长行按字符硬切时不会把 `⟦CODOVO_CODE_n⟧` 占位符切成两半。
 */
import assert from "node:assert/strict";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

try {
  const { assembleTranslation, prepareDocument } = await server.ssrLoadModule(
    "/src/lib/translate.ts",
  );

  const limit = 6000;
  // 让行内代码占位符正好落在 6000 字符的硬切点附近：prefix + 空格后是占位符
  const prefix = "x".repeat(5995);
  const suffix = "y".repeat(7000);
  const source = `${prefix} \`npm run build\` ${suffix}`;

  const prepared = prepareDocument(source, limit);
  assert.equal(prepared.blocks.length, 1, "行内代码应被屏蔽成一个占位符");
  assert.ok(prepared.chunks.length >= 2, "超长行应该被拆成多段");

  const marker = "⟦CODOVO_CODE_0⟧";
  assert.ok(
    prepared.chunks.some((chunk) => chunk.includes(marker)),
    "占位符应完整出现在某一段里",
  );
  assert.equal(
    prepared.chunks.join("").split(marker).length - 1,
    1,
    "占位符不能被重复或拆开",
  );

  for (const chunk of prepared.chunks) {
    const rest = chunk.replace(/⟦CODOVO_CODE_\d+⟧/g, "");
    assert.ok(
      !rest.includes("CODOVO_CODE") && !/[⟦⟧]/.test(rest),
      `片段里残留了被切断的占位符：${rest.slice(0, 80)}`,
    );
  }

  // 用原文片段直接当译文拼回去：占位符必须都能还原，内容不丢
  const assembled = assembleTranslation(prepared.chunks, prepared.blocks);
  assert.equal(
    assembled.replace(/\s+/g, ""),
    source.replace(/\s+/g, ""),
    "还原后的正文应与原文一致（忽略分段产生的空白）",
  );

  console.log("translate split test passed");
} finally {
  await server.close();
}
