import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? process.cwd());
const SKILL_DIR = path.resolve(process.env.SKILL_DIR ?? "C:/Users/Administrator/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations");
const RUNTIME_NODE_MODULES = path.resolve(process.env.RUNTIME_NODE_MODULES ?? "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules");
const RUNTIME_PYTHON = path.resolve(process.env.RUNTIME_PYTHON ?? "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe");
const revision = process.env.PPTX_REV ?? "v1";
const buildDir = path.join(workspaceDir, ".pptx-build", revision);
const qaDir = path.join(workspaceDir, "artifacts", "pptx-qa");
const finalPath = path.join(qaDir, `毕业设计答辩PPT-${revision}.pptx`);
const require = createRequire(import.meta.url);
const JSZip = require(path.join(RUNTIME_NODE_MODULES, "jszip"));
const { xml2js, js2xml } = require(path.join(RUNTIME_NODE_MODULES, "xml-js"));

const artifactToolUrl = pathToFileURL(path.join(RUNTIME_NODE_MODULES, "@oai", "artifact-tool", "dist", "artifact_tool.mjs")).href;
const { Presentation, PresentationFile } = await import(artifactToolUrl);
const {
  applyPresentationChartFont,
  finalizePresentation,
  makeNativeBulletParagraphs,
  resolvePresentationFont,
} = await import(pathToFileURL(path.join(SKILL_DIR, "container_tools", "artifact_tool_utils.mjs")).href);

await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(qaDir, { recursive: true });

const FONT = resolvePresentationFont({ fontFamily: "Microsoft YaHei" });
const W = 1280;
const H = 720;
const TOTAL_SLIDES = 12;
const EXPECTED_SIZE_EMU = "12192000,6858000";

const C = {
  bg: "#F6F8F7",
  paper: "#FFFFFF",
  ink: "#17211F",
  muted: "#5D6965",
  faint: "#87918D",
  line: "#D8E0DC",
  soft: "#EBF0ED",
  green: "#1F7A63",
  greenDark: "#155C4B",
  greenLight: "#E4F1EB",
  blue: "#2F6FA5",
  blueDark: "#245A87",
  blueLight: "#E7F0F7",
  orange: "#D77A2B",
  orangeLight: "#FFF0E2",
  charcoal: "#202A27",
};

let activeSlideNumber = 0;
const imageAltTextsBySlide = new Map();

function addShape(slide, geometry, x, y, w, h, options = {}) {
  return slide.shapes.add({
    geometry,
    position: { left: x, top: y, width: w, height: h },
    fill: options.fill ?? "none",
    line: options.line ?? { fill: "none", width: 0 },
    ...(options.borderRadius ? { borderRadius: options.borderRadius } : {}),
    ...(options.shadow ? { shadow: options.shadow } : {}),
    ...(options.name ? { name: options.name } : {}),
  });
}

function addText(slide, text, x, y, w, h, options = {}) {
  const shape = addShape(slide, "textbox", x, y, w, h, {
    fill: options.fill ?? "none",
    line: options.line ?? { fill: "none", width: 0 },
    borderRadius: options.borderRadius,
    shadow: options.shadow,
    name: options.name,
  });
  shape.text = text;
  shape.text.style = {
    typeface: FONT,
    fontSize: options.fontSize ?? 24,
    bold: options.bold ?? false,
    color: options.color ?? C.ink,
    alignment: options.align ?? "left",
    verticalAlignment: options.vAlign ?? "top",
    autoFit: options.autoFit ?? "none",
    wrap: options.wrap ?? "square",
    lineSpacing: options.lineSpacing ?? 1.08,
    insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function addRichText(slide, paragraphs, x, y, w, h, options = {}) {
  const shape = addText(slide, "", x, y, w, h, options);
  shape.text = paragraphs;
  shape.text.style = {
    typeface: FONT,
    fontSize: options.fontSize ?? 24,
    bold: options.bold ?? false,
    color: options.color ?? C.ink,
    alignment: options.align ?? "left",
    verticalAlignment: options.vAlign ?? "top",
    autoFit: options.autoFit ?? "none",
    wrap: options.wrap ?? "square",
    lineSpacing: options.lineSpacing ?? 1.08,
    insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function addBulletList(slide, items, x, y, w, h, options = {}) {
  const shape = addText(slide, "", x, y, w, h, options);
  shape.text = makeNativeBulletParagraphs(items, {
    marginLeftPoints: options.marginLeftPoints ?? 17,
    hangingPoints: options.hangingPoints ?? 8,
    spaceAfterPoints: options.spaceAfterPoints ?? 7,
  });
  shape.text.style = {
    typeface: FONT,
    fontSize: options.fontSize ?? 23,
    color: options.color ?? C.ink,
    autoFit: "none",
    wrap: "square",
    lineSpacing: options.lineSpacing ?? 1.08,
    insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function addLine(slide, x, y, w, h, color = C.line, width = 1, style = "solid") {
  return addShape(slide, "line", x, y, w, h, {
    fill: "none",
    line: { style, fill: color, width },
  });
}

function addHeader(slide, page, title) {
  addShape(slide, "rect", 54, 48, 8, 50, { fill: C.green, line: { fill: "none", width: 0 } });
  addText(slide, title, 82, 45, 1030, 58, { fontSize: 42, bold: true, color: C.ink, vAlign: "middle" });
  addText(slide, String(page).padStart(2, "0"), 1150, 52, 70, 34, { fontSize: 20, bold: true, color: C.green, align: "right" });
  addLine(slide, 54, 116, 1166, 0, C.line, 1);
}

function addFooter(slide, page) {
  addLine(slide, 54, 674, 1166, 0, C.line, 1);
  addText(slide, "柯佳伟｜多人实时协同编辑系统", 54, 685, 350, 18, { fontSize: 13, color: C.faint });
  addText(slide, `${page} / ${TOTAL_SLIDES}`, 1120, 685, 100, 18, { fontSize: 13, color: C.faint, align: "right" });
}

function newSlide(page, title, withHeader = true) {
  activeSlideNumber = page;
  const slide = presentation.slides.add();
  slide.background.fill = C.bg;
  if (withHeader) addHeader(slide, page, title);
  addFooter(slide, page);
  return slide;
}

function addLabel(slide, text, x, y, w, options = {}) {
  return addText(slide, text, x, y, w, options.height ?? 28, {
    fontSize: options.fontSize ?? 17,
    bold: options.bold ?? true,
    color: options.color ?? C.green,
    align: options.align ?? "left",
    vAlign: "middle",
  });
}

function addMetric(slide, value, label, x, y, w, options = {}) {
  addText(slide, value, x, y, w, 72, {
    fontSize: options.valueSize ?? 54,
    bold: true,
    color: options.color ?? C.green,
    align: options.align ?? "left",
    vAlign: "middle",
  });
  addText(slide, label, x, y + 72, w, 42, {
    fontSize: options.labelSize ?? 18,
    color: options.labelColor ?? C.muted,
    align: options.align ?? "left",
    vAlign: "top",
  });
}

function addPanel(slide, x, y, w, h, options = {}) {
  return addShape(slide, "rect", x, y, w, h, {
    fill: options.fill ?? C.paper,
    line: options.line ?? { style: "solid", fill: C.line, width: 1 },
    borderRadius: options.radius ?? 6,
    shadow: options.shadow,
  });
}

function addNode(slide, text, x, y, w, h, options = {}) {
  const node = addShape(slide, options.geometry ?? "roundRect", x, y, w, h, {
    fill: options.fill ?? C.paper,
    line: { style: "solid", fill: options.stroke ?? C.line, width: options.lineWidth ?? 1.5 },
    borderRadius: options.radius ?? 7,
  });
  node.text = text;
  node.text.style = {
    typeface: FONT,
    fontSize: options.fontSize ?? 21,
    bold: options.bold ?? true,
    color: options.color ?? C.ink,
    alignment: "center",
    verticalAlignment: "middle",
    autoFit: "none",
    wrap: "square",
    lineSpacing: 1.0,
    insets: { top: 6, right: 8, bottom: 6, left: 8 },
  };
  return node;
}

function connect(slide, from, to, options = {}) {
  return slide.shapes.connect(from, to, {
    kind: options.kind ?? "straight",
    fromSide: options.fromSide ?? "right",
    toSide: options.toSide ?? "left",
    line: { style: options.style ?? "solid", fill: options.color ?? C.blue, width: options.width ?? 2 },
    tail: { type: options.head ?? "triangle", width: "sm", length: "sm" },
  });
}

async function addImage(slide, relativePath, x, y, w, h, options = {}) {
  const absolute = path.join(workspaceDir, relativePath.replaceAll("/", path.sep));
  const bytes = await fs.readFile(absolute);
  const alt = options.alt ?? path.basename(relativePath);
  if (options.frame !== false) {
    addShape(slide, "rect", x - 5, y - 5, w + 10, h + 10, {
      fill: C.paper,
      line: { style: "solid", fill: options.frameColor ?? C.line, width: 1 },
      borderRadius: options.radius ?? 6,
      shadow: options.shadow ?? "shadow-sm",
    });
  }
  const image = slide.images.add({
    blob: bytes,
    contentType: "image/png",
    alt,
    fit: options.fit ?? "contain",
    position: { left: x, top: y, width: w, height: h },
    geometry: options.geometry ?? "rect",
    ...(options.radius ? { borderRadius: options.radius } : {}),
    ...(options.crop ? { crop: options.crop } : {}),
  });
  image.alt = alt;
  const slideAlts = imageAltTextsBySlide.get(activeSlideNumber) ?? [];
  slideAlts.push(alt);
  imageAltTextsBySlide.set(activeSlideNumber, slideAlts);
  return image;
}

function setNotes(slide, script, sources) {
  const notes = `${script}\n\n证据来源：${sources.join("；")}`;
  slide.speakerNotes.textFrame.setText(notes);
  slide.speakerNotes.setVisible(true);
}

function findXmlElements(node, name, results = []) {
  if (!node || typeof node !== "object") return results;
  if (node.type === "element" && node.name === name) results.push(node);
  for (const child of node.elements ?? []) findXmlElements(child, name, results);
  return results;
}

function setXmlElementText(document, name, value) {
  const [element] = findXmlElements(document, name);
  if (!element) throw new Error(`Missing XML element: ${name}`);
  element.elements = [{ type: "text", text: String(value) }];
}

async function patchPresentationPackage(pptxPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath), { checkCRC32: true });
  const appPart = zip.file("docProps/app.xml");
  if (!appPart) throw new Error("Missing docProps/app.xml");

  const appDocument = xml2js(await appPart.async("string"), { compact: false });
  setXmlElementText(appDocument, "ap:Slides", TOTAL_SLIDES);
  setXmlElementText(appDocument, "ap:Notes", TOTAL_SLIDES);
  zip.file("docProps/app.xml", js2xml(appDocument, { compact: false, spaces: 0 }));

  for (const [slideNumber, altTexts] of imageAltTextsBySlide.entries()) {
    const slidePartName = `ppt/slides/slide${slideNumber}.xml`;
    const slidePart = zip.file(slidePartName);
    if (!slidePart) throw new Error(`Missing ${slidePartName}`);
    const slideDocument = xml2js(await slidePart.async("string"), { compact: false });
    const pictures = findXmlElements(slideDocument, "p:pic");
    if (pictures.length !== altTexts.length) {
      throw new Error(`${slidePartName} has ${pictures.length} pictures; expected ${altTexts.length}`);
    }
    pictures.forEach((picture, index) => {
      const [properties] = findXmlElements(picture, "p:cNvPr");
      if (!properties) throw new Error(`Missing p:cNvPr in ${slidePartName} picture ${index + 1}`);
      properties.attributes = {
        ...(properties.attributes ?? {}),
        descr: altTexts[index],
        title: altTexts[index],
      };
    });
    zip.file(slidePartName, js2xml(slideDocument, { compact: false, spaces: 0 }));
  }

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(pptxPath, bytes);
}

const presentation = Presentation.create({
  slideSize: { width: W, height: H },
});

// 1. Cover
{
  const slide = newSlide(1, "", false);
  addShape(slide, "rect", 0, 0, 14, H, { fill: C.green, line: { fill: "none", width: 0 } });
  addText(slide, "基于SpringBoot与WebSocket的\n多人实时协同编辑系统的设计与实现", 72, 74, 1100, 160, {
    fontSize: 54,
    bold: true,
    color: C.ink,
    lineSpacing: 0.98,
    vAlign: "middle",
  });
  addText(slide, "一种一致性模型，驱动三类协同应用", 76, 247, 690, 38, {
    fontSize: 26,
    color: C.greenDark,
    bold: true,
  });
  addLine(slide, 76, 305, 506, 0, C.green, 3);
  addText(slide, "答辩人  柯佳伟\n学号  20235102034\n专业班级  软件工程一班\n指导教师  揣小龙 讲师", 76, 344, 430, 148, {
    fontSize: 21,
    color: C.muted,
    lineSpacing: 1.3,
  });
  addText(slide, "吉林农业科技学院", 76, 548, 350, 32, { fontSize: 20, bold: true, color: C.ink });
  await addImage(slide, "artifacts/e2e-vue-final/01-owner-default-space.png", 565, 332, 632, 316, {
    alt: "最终 Playwright 验证中的协同工作台",
    fit: "cover",
    crop: { left: 0, top: 0.02, right: 0, bottom: 0.02 },
    shadow: "shadow-md",
  });
  setNotes(slide,
    "各位老师好，我的毕业设计题目是《基于SpringBoot与WebSocket的多人实时协同编辑系统的设计与实现》。本项目使用 Java 自研元素级一致性引擎，并用同一套引擎驱动协同文档、白板和看板。下面从问题、设计、实现和验证四部分汇报。",
    ["D:/bishe/docs/20235102034-柯佳伟-任务书.docx", "artifacts/e2e-vue-final/01-owner-default-space.png"]);
}

// 2. Research problem and scope
{
  const slide = newSlide(2, "研究问题与范围");
  addText(slide, "并发编辑要求消息以不同顺序到达时，各端仍产生相同的最终状态。", 66, 138, 1120, 44, {
    fontSize: 27,
    bold: true,
    color: C.ink,
  });
  const users = [
    addNode(slide, "用户 A\n编辑段落", 78, 218, 180, 78, { fill: C.blueLight, stroke: C.blue, color: C.blueDark }),
    addNode(slide, "用户 B\n移动卡片", 78, 324, 180, 78, { fill: C.greenLight, stroke: C.green, color: C.greenDark }),
    addNode(slide, "用户 C\n拖拽任务", 78, 430, 180, 78, { fill: C.soft, stroke: C.faint, color: C.ink }),
  ];
  const server = addNode(slide, "WebSocket\n协同服务", 390, 310, 208, 108, { fill: C.paper, stroke: C.green, lineWidth: 2, fontSize: 24 });
  const state = addNode(slide, "一致状态\ncanonicalHash 相同", 748, 310, 240, 108, { fill: C.greenLight, stroke: C.green, lineWidth: 2, color: C.greenDark, fontSize: 23 });
  users.forEach((user, index) => connect(slide, user, server, { color: index === 0 ? C.blue : C.green, kind: "elbow" }));
  connect(slide, server, state, { color: C.blue, width: 3 });
  addText(slide, "到达顺序不同", 298, 264, 180, 28, { fontSize: 17, color: C.muted, align: "center" });
  addText(slide, "统一裁决", 610, 274, 120, 28, { fontSize: 17, color: C.blueDark, bold: true, align: "center" });

  addShape(slide, "rect", 1020, 205, 3, 340, { fill: C.line, line: { fill: "none", width: 0 } });
  addLabel(slide, "实现范围", 1052, 210, 150, { fontSize: 19, color: C.green });
  addText(slide, "段落级文档协同\n结构化白板卡片\n看板列与任务卡", 1052, 250, 168, 130, { fontSize: 20, color: C.ink, lineSpacing: 1.28 });
  addLabel(slide, "明确边界", 1052, 409, 150, { fontSize: 19, color: C.orange });
  addText(slide, "不做字符级 CRDT\n不做白板自由绘制", 1052, 449, 168, 90, { fontSize: 19, color: C.muted, lineSpacing: 1.3 });
  setNotes(slide,
    "协同编辑的难点是多个用户同时修改、消息乱序、重复投递或中途断线后，各端仍能得到相同结果。项目把复杂度控制在元素和字段级：文档按段落协同，白板和看板按结构化卡片协同。字符级 CRDT 与白板自由绘制不在定稿范围内。",
    ["D:/bishe/docs/20235102034-柯佳伟-任务书.docx", "D:/bishe/docs/20235102034-柯佳伟-开题报告.docx"]);
}

// 3. Architecture
{
  const slide = newSlide(3, "系统架构与职责分工");
  addText(slide, "REST 处理业务控制，WebSocket 处理实时数据，MySQL 保存权威日志。", 66, 138, 1100, 40, {
    fontSize: 25,
    bold: true,
    color: C.ink,
  });
  const browser = addNode(slide, "浏览器用户\nA / B / C", 66, 255, 180, 124, { fill: C.paper, stroke: C.line, fontSize: 23 });
  const vue = addNode(slide, "Vue 3 + Vite\n工作台与三类编辑器", 298, 255, 222, 124, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 22 });
  const spring = addPanel(slide, 586, 194, 330, 248, { fill: C.paper, line: { style: "solid", fill: C.line, width: 1.5 } });
  addText(slide, "Spring Boot 3", 610, 214, 282, 36, { fontSize: 25, bold: true, color: C.ink, align: "center" });
  const rest = addNode(slide, "REST 控制面\n认证 / 空间 / 历史\n检索 / 导出 / 统计", 610, 270, 132, 134, { fill: C.soft, stroke: C.line, fontSize: 18 });
  const ws = addNode(slide, "WebSocket 数据面\n操作 / 在线状态\n心跳 / 断线同步", 760, 270, 132, 134, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 18 });
  const engine = addNode(slide, "自研 engine\nElement + Op\nLamport + LWW", 982, 200, 224, 132, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 21 });
  const db = addNode(slide, "MySQL 8\noperation_log\nelement_snapshot", 982, 384, 224, 132, { fill: C.paper, stroke: C.line, fontSize: 20 });
  connect(slide, browser, vue, { color: C.green });
  connect(slide, vue, spring, { color: C.blue, width: 3 });
  connect(slide, ws, engine, { color: C.blue });
  connect(slide, rest, db, { color: C.green, kind: "elbow", fromSide: "bottom", toSide: "left" });
  connect(slide, engine, db, { color: C.green, kind: "straight", fromSide: "bottom", toSide: "top" });
  addText(slide, "HTTP /api/*", 388, 218, 130, 24, { fontSize: 16, color: C.muted, align: "center" });
  addText(slide, "WebSocket /ws/collab", 388, 393, 170, 24, { fontSize: 16, color: C.blueDark, align: "center" });
  addText(slide, "持久化成功后才更新内存并广播", 930, 545, 276, 52, { fontSize: 18, bold: true, color: C.greenDark, align: "center", vAlign: "middle" });
  addText(slide, "Java 17 编译目标｜原生 RFC 6455 JSON｜Maven 多模块", 66, 612, 840, 28, { fontSize: 17, color: C.muted });
  setNotes(slide,
    "系统采用前后端分离架构。登录、空间管理、历史、搜索、导出和统计走 REST；实时操作、在线状态、心跳与断线同步走原生 WebSocket JSON 协议。服务端按文档建立房间，自研引擎完成合并，MySQL 操作日志保存权威事实。",
    ["docs/architecture.md", "docs/database-er.md", "docs/websocket-protocol.md"]);
}

// 4. Element + Op
{
  const slide = newSlide(4, "统一元素与操作模型");
  addText(slide, "三类界面都转换为元素字段与三种操作，上层只负责业务投影。", 66, 138, 1080, 40, { fontSize: 25, bold: true });
  addPanel(slide, 66, 198, 500, 336, { fill: C.paper });
  addShape(slide, "rect", 66, 198, 500, 56, { fill: C.green, line: { fill: "none", width: 0 }, borderRadius: 6 });
  addText(slide, "Element", 90, 208, 210, 34, { fontSize: 27, bold: true, color: C.paper, vAlign: "middle" });
  const fields = [
    ["id", "全局唯一标识"],
    ["type", "DOC / TEXT / CARD / COLUMN"],
    ["rootClock", "创建与类型声明时钟"],
    ["fields", "字段 -> (value, writtenAt)"],
    ["#tombstone", "墓碑删除标记"],
  ];
  fields.forEach(([key, value], index) => {
    const y = 270 + index * 49;
    addText(slide, key, 94, y, 142, 30, { fontSize: 20, bold: true, color: index === 4 ? C.orange : C.greenDark, vAlign: "middle" });
    addText(slide, value, 242, y, 290, 30, { fontSize: 19, color: C.ink, vAlign: "middle" });
    if (index < fields.length - 1) addLine(slide, 90, y + 39, 440, 0, C.line, 1);
  });

  addPanel(slide, 620, 198, 268, 336, { fill: C.paper });
  addText(slide, "Op", 646, 216, 216, 34, { fontSize: 27, bold: true, color: C.blueDark, align: "center" });
  const opItems = [
    ["ADD", "创建元素"],
    ["PUT", "写入一个字段"],
    ["DELETE", "写入墓碑"],
  ];
  opItems.forEach(([op, label], index) => {
    const y = 280 + index * 74;
    addNode(slide, op, 642, y, 102, 46, { fill: index === 2 ? C.orangeLight : C.blueLight, stroke: index === 2 ? C.orange : C.blue, color: index === 2 ? C.orange : C.blueDark, fontSize: 17 });
    addText(slide, label, 758, y + 4, 104, 38, { fontSize: 17, color: C.ink, vAlign: "middle" });
  });
  addText(slide, "clock = replicaId:counter", 642, 483, 224, 28, { fontSize: 16, color: C.muted, align: "center" });

  addLabel(slide, "业务字段映射", 916, 198, 280, { fontSize: 20, color: C.green });
  const apps = [
    { title: "协同文档", fields: "DOC / TEXT\ntitle / text / order", color: C.green, fill: C.greenLight },
    { title: "协同白板", fields: "CARD\nx / y / w / h\ncolor / z", color: C.blue, fill: C.blueLight },
    { title: "协同看板", fields: "COLUMN / CARD\ntitle / column / order", color: C.orange, fill: C.orangeLight },
  ];
  apps.forEach((app, index) => {
    const y = 238 + index * 112;
    addShape(slide, "rect", 916, y, 290, 98, { fill: app.fill, line: { style: "solid", fill: app.color, width: 1.5 }, borderRadius: 6 });
    addText(slide, app.title, 936, y + 12, 116, 34, { fontSize: 18, bold: true, color: app.color, vAlign: "middle" });
    addText(slide, app.fields, 1058, y + 10, 130, 76, { fontSize: 15, color: C.ink, lineSpacing: 1.08, vAlign: "middle" });
  });
  addText(slide, "一致性算法只实现一次，三类应用共享连接、合并与持久化链路。", 66, 574, 1138, 54, { fontSize: 22, bold: true, color: C.greenDark, align: "center", vAlign: "middle" });
  setNotes(slide,
    "系统把三类业务统一表示为带唯一 ID 的元素。元素的每个字段同时保存值和最后写入时钟，所有变化归结为 ADD、PUT 和 DELETE。文档正文、白板位置和看板所属列虽然业务含义不同，对引擎而言都是字段写入。",
    ["engine/src/main/java/com/bishe/engine/Element.java", "engine/src/main/java/com/bishe/engine/Op.java", "engine/src/main/java/com/bishe/engine/ElementType.java"]);
}

// 5. Lamport + LWW
{
  const slide = newSlide(5, "Lamport 时钟与字段级 LWW");
  addText(slide, "比较键为 (counter, replicaId)，相同字段只接受更大的时钟。", 66, 138, 1080, 40, { fontSize: 25, bold: true });
  const a = addNode(slide, "用户 A\ntext = 方案 A\nclock = (7, A)", 74, 212, 250, 118, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 21 });
  const b = addNode(slide, "用户 B\ntext = 方案 B\nclock = (7, B)", 74, 380, 250, 118, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 21 });
  const compare = addNode(slide, "先比较 counter\n再比较 replicaId\n(7, B) > (7, A)", 454, 286, 280, 144, { fill: C.paper, stroke: C.line, lineWidth: 2, fontSize: 22 });
  const win = addNode(slide, "唯一结果\ntext = 方案 B", 866, 286, 248, 144, { fill: C.greenLight, stroke: C.green, lineWidth: 2, color: C.greenDark, fontSize: 25 });
  connect(slide, a, compare, { color: C.blue, kind: "elbow" });
  connect(slide, b, compare, { color: C.green, kind: "elbow" });
  connect(slide, compare, win, { color: C.green, width: 3 });
  addText(slide, "副本 1：先 A 后 B", 852, 214, 276, 28, { fontSize: 17, color: C.muted, align: "center" });
  addText(slide, "副本 2：先 B 后 A", 852, 458, 276, 28, { fontSize: 17, color: C.muted, align: "center" });
  addLine(slide, 866, 248, 248, 0, C.line, 1, "dashed");
  addLine(slide, 866, 482, 248, 0, C.line, 1, "dashed");
  addShape(slide, "rect", 66, 550, 1140, 78, { fill: C.orangeLight, line: { style: "solid", fill: C.orange, width: 1 }, borderRadius: 5 });
  addText(slide, "墓碑也是字段", 88, 565, 180, 32, { fontSize: 21, bold: true, color: C.orange });
  addText(slide, "DELETE 写入 #tombstone=true，旧时钟晚到也不能让已删除对象复活；历史仍保留。", 270, 565, 910, 36, { fontSize: 20, color: C.ink, vAlign: "middle" });
  setNotes(slide,
    "每次操作携带 Lamport 时钟，比较时先看计数器，计数相同再用副本 ID 打破平局，因此任意两次写入都能得到唯一顺序。LWW 按元素字段裁决，旧操作即使晚到也不会覆盖新值。删除同样写入带时钟的墓碑字段。",
    ["engine/src/main/java/com/bishe/engine/LamportClock.java", "engine/src/main/java/com/bishe/engine/FieldValue.java", "engine/src/main/java/com/bishe/engine/DocState.java"]);
}

// 6. Reliable synchronization
{
  const slide = newSlide(6, "提交、重连与恢复");
  addText(slide, "数据库追加成功定义提交边界，断线后按版本游标恢复。", 66, 138, 1080, 40, { fontSize: 25, bold: true });
  const nodes = [
    addNode(slide, "1 发送 op", 60, 206, 160, 70, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 19 }),
    addNode(slide, "2 权限与协议", 266, 206, 170, 70, { fill: C.paper, stroke: C.line, fontSize: 18 }),
    addNode(slide, "3 串行分配 rev", 482, 206, 184, 70, { fill: C.paper, stroke: C.green, color: C.greenDark, fontSize: 18 }),
    addNode(slide, "4 写入日志", 712, 206, 160, 70, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 19 }),
    addNode(slide, "5 更新并广播", 918, 206, 184, 70, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 19 }),
  ];
  for (let i = 0; i < nodes.length - 1; i += 1) connect(slide, nodes[i], nodes[i + 1], { color: i === 2 ? C.green : C.blue });
  addText(slide, "PERSIST_FAILED 时不改内存、不推进 rev、不广播", 742, 296, 420, 26, { fontSize: 16, color: C.orange, align: "center" });

  addLabel(slide, "断线恢复", 66, 342, 200, { fontSize: 20, color: C.green });
  addLine(slide, 86, 408, 640, 0, C.line, 3);
  const times = [
    { x: 96, title: "rev 20", sub: "连接正常", color: C.green },
    { x: 278, title: "离线 30s", sub: "停止编辑", color: C.orange },
    { x: 468, title: "rev 24", sub: "服务端继续写入", color: C.blue },
    { x: 658, title: "补齐 21..24", sub: "失败则全量快照", color: C.green },
  ];
  times.forEach((item) => {
    addShape(slide, "ellipse", item.x, 394, 28, 28, { fill: item.color, line: { fill: C.paper, width: 2 } });
    addText(slide, item.title, item.x - 30, 438, 100, 26, { fontSize: 18, bold: true, color: item.color, align: "center" });
    addText(slide, item.sub, item.x - 52, 468, 144, 46, { fontSize: 16, color: C.muted, align: "center", lineSpacing: 1.05 });
  });
  addShape(slide, "rect", 66, 546, 662, 78, { fill: C.soft, line: { fill: "none", width: 0 }, borderRadius: 5 });
  addText(slide, "启动恢复", 86, 561, 120, 26, { fontSize: 19, bold: true, color: C.greenDark });
  addText(slide, "最新 element_snapshot + 后续 operation_log 回放", 204, 561, 502, 28, { fontSize: 18, color: C.ink });
  addText(slide, "历史恢复", 86, 594, 120, 26, { fontSize: 19, bold: true, color: C.greenDark });
  addText(slide, "计算差异并追加新操作，旧历史不改写", 204, 594, 502, 28, { fontSize: 18, color: C.ink });
  await addImage(slide, "artifacts/e2e-vue-final/08-editor-reconnected-after-30s.png", 778, 350, 426, 274, {
    alt: "编辑者断线三十秒后自动补齐的最终页面",
    fit: "cover",
    crop: { left: 0.03, top: 0.05, right: 0.03, bottom: 0.2 },
  });
  setNotes(slide,
    "数据库追加成功后，房间才更新内存状态、推进版本并广播。客户端断线重连时携带 lastRev，服务端优先返回缺失增量；版本无法连续补齐时回退到全量快照。最终 Playwright 批次实测离线 30003 毫秒后自动重连并补齐。",
    ["docs/websocket-protocol.md", "server/src/main/java/com/bishe/server/ws/CollabRoom.java", "artifacts/e2e-vue-final/08-editor-reconnected-after-30s.png"]);
}

// 7. Three applications
{
  const slide = newSlide(7, "三类协同应用");
  addText(slide, "同一操作协议覆盖段落、白板卡片和看板任务。", 66, 138, 980, 40, { fontSize: 25, bold: true });
  const columns = [
    {
      x: 54,
      title: "协同文档",
      asset: "artifacts/e2e-vue-final/03-document-owner-editor-sync.png",
      detail: "段落增删、编辑与排序\nTEXT.text / order",
      color: C.green,
    },
    {
      x: 448,
      title: "协同白板",
      asset: "artifacts/e2e-vue-final/06-board-synced.png",
      detail: "位置、尺寸、颜色与层级\nCARD.x / y / w / h / color / z",
      color: C.orange,
    },
    {
      x: 842,
      title: "协同看板",
      asset: "artifacts/e2e-vue-final/07-kanban-drag-synced.png",
      detail: "列与任务卡排序、跨列流转\nCOLUMN.order / CARD.column",
      color: C.blue,
    },
  ];
  for (const col of columns) {
    addText(slide, col.title, col.x, 190, 344, 38, { fontSize: 25, bold: true, color: col.color, align: "center" });
    await addImage(slide, col.asset, col.x, 242, 344, 229, { alt: `${col.title}最终同步截图`, fit: "contain" });
    addLine(slide, col.x + 30, 498, 284, 0, col.color, 3);
    addText(slide, col.detail, col.x + 18, 516, 308, 74, { fontSize: 18, color: C.ink, align: "center", lineSpacing: 1.2 });
  }
  addText(slide, "三类编辑器共享在线成员、连接状态、历史入口、冲突合并与持久化链路。", 66, 618, 1140, 34, { fontSize: 20, bold: true, color: C.greenDark, align: "center" });
  setNotes(slide,
    "文档以段落为元素，白板同步结构化卡片的几何与样式字段，看板用列表和卡片字段表达排序及状态流转。三个编辑器界面不同，但连接、广播、冲突合并与持久化都复用公共链路。",
    ["artifacts/e2e-vue-final/03-document-owner-editor-sync.png", "artifacts/e2e-vue-final/06-board-synced.png", "artifacts/e2e-vue-final/07-kanban-drag-synced.png"]);
}

// 8. Roles and permissions
{
  const slide = newSlide(8, "JWT 与空间角色权限");
  addText(slide, "JWT 确认身份，space_member.role 决定资源权限。", 66, 138, 980, 40, { fontSize: 25, bold: true });
  addLabel(slide, "权限矩阵", 66, 196, 200, { fontSize: 20, color: C.green });
  const matrixX = 66;
  const matrixY = 236;
  const colW = [310, 108, 108, 108];
  const matrix = [
    ["能力", "owner", "editor", "viewer"],
    ["查看、历史、搜索、导出、统计", "是", "是", "是"],
    ["创建、实时编辑、恢复历史", "是", "是", "否"],
    ["邀请或调整成员", "是", "否", "否"],
    ["删除内容", "是", "否", "否"],
  ];
  const matrixTable = slide.tables.add({
    rows: matrix.length,
    columns: matrix[0].length,
    left: matrixX,
    top: matrixY,
    width: colW.reduce((sum, width) => sum + width, 0),
    height: 280,
    columnWidths: colW,
    values: matrix,
  });
  matrixTable.borders.assign({ style: "solid", fill: C.line, width: 1 });
  matrixTable.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: 4 }).assign({
    fill: C.charcoal,
    textStyle: { typeface: FONT, fontSize: 18, bold: true, color: C.paper, alignment: "center" },
    margins: { top: 10, right: 10, bottom: 10, left: 10 },
    anchor: "middle",
  });
  matrixTable.cells.block({ row: 1, column: 0, rowCount: 4, columnCount: 1 }).assign({
    fill: C.paper,
    textStyle: { typeface: FONT, fontSize: 18, color: C.ink, alignment: "left" },
    margins: { top: 10, right: 12, bottom: 10, left: 12 },
    anchor: "middle",
  });
  matrixTable.cells.block({ row: 1, column: 1, rowCount: 4, columnCount: 3 }).assign({
    fill: C.paper,
    textStyle: { typeface: FONT, fontSize: 18, bold: true, color: C.greenDark, alignment: "center" },
    margins: { top: 10, right: 8, bottom: 10, left: 8 },
    anchor: "middle",
  });
  [[2, 3], [3, 2], [3, 3], [4, 2], [4, 3]].forEach(([row, column]) => {
    matrixTable.getCell(row, column).fill = "#F1F3F2";
    matrixTable.getCell(row, column).text.style = {
      typeface: FONT,
      fontSize: 18,
      bold: true,
      color: C.faint,
      alignment: "center",
      verticalAlignment: "middle",
    };
  });
  addText(slide, "WebSocket 每次写入都重新查询当前角色，避免角色变更后沿用旧权限。", 66, 548, 634, 56, { fontSize: 19, bold: true, color: C.blueDark, vAlign: "middle" });

  await addImage(slide, "artifacts/e2e-vue-final/02-owner-members.png", 756, 190, 448, 220, {
    alt: "所有者工作台中的空间成员角色",
    fit: "cover",
    crop: { left: 0.61, top: 0.13, right: 0, bottom: 0.34 },
  });
  addText(slide, "所有者管理空间成员", 756, 420, 448, 28, { fontSize: 17, color: C.muted, align: "center" });
  await addImage(slide, "artifacts/e2e-vue-final/05-viewer-document-readonly.png", 756, 448, 448, 180, {
    alt: "只读者打开协同文档后的只读提示",
    fit: "cover",
    crop: { left: 0.38, top: 0, right: 0.12, bottom: 0.76 },
  });
  addText(slide, "viewer 可查看实时结果，但写入与恢复不可用", 756, 632, 448, 24, { fontSize: 16, color: C.muted, align: "center" });
  setNotes(slide,
    "认证和授权分成两层。JWT 证明当前用户身份，真正的资源权限来自空间成员表。所有者可以管理成员和删除内容，编辑者可以创建、编辑与恢复，只读者可以查看、搜索、导出和统计，但不能写入。WebSocket 每次写操作都会重新查角色。",
    ["docs/api-reference.md", "server/src/main/java/com/bishe/server/auth/AccessService.java", "artifacts/e2e-vue-final/02-owner-members.png", "artifacts/e2e-vue-final/05-viewer-document-readonly.png"]);
}

// 9. Log-powered capabilities
{
  const slide = newSlide(9, "操作日志驱动的平台能力");
  addText(slide, "同一份追加日志服务实时同步、历史恢复与统计。", 66, 138, 920, 40, { fontSize: 25, bold: true });
  const log = addNode(slide, "operation_log\nseq · clock · opId · actor", 236, 336, 278, 110, { fill: C.charcoal, stroke: C.charcoal, color: C.paper, fontSize: 22 });
  const history = addNode(slide, "历史\n回放指定 rev\n恢复追加新操作", 68, 204, 204, 102, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 18 });
  const search = addNode(slide, "检索\n当前有效状态\n标题与正文", 478, 204, 204, 102, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 18 });
  const exportNode = addNode(slide, "导出\n三类内容\n转换为 Markdown", 68, 478, 204, 102, { fill: C.soft, stroke: C.faint, fontSize: 18 });
  const stats = addNode(slide, "统计\n应用 / 操作 / 日期\n贡献者聚合", 478, 478, 204, 102, { fill: C.orangeLight, stroke: C.orange, color: C.orange, fontSize: 18 });
  connect(slide, log, history, { color: C.green, kind: "elbow", fromSide: "left", toSide: "right" });
  connect(slide, log, search, { color: C.blue, kind: "elbow", fromSide: "top", toSide: "bottom" });
  connect(slide, log, exportNode, { color: C.faint, kind: "elbow", fromSide: "bottom", toSide: "right" });
  connect(slide, log, stats, { color: C.orange, kind: "elbow", fromSide: "right", toSide: "left" });

  await addImage(slide, "artifacts/e2e-vue-final/10-collaboration-stats.png", 742, 190, 468, 312, {
    alt: "正文搜索命中与协同统计页面",
    fit: "cover",
    crop: { left: 0.08, top: 0, right: 0, bottom: 0.08 },
  });
  addText(slide, "Playwright 同轮验证：正文搜索命中、统计增长、导出文件非空。", 742, 520, 468, 62, { fontSize: 18, bold: true, color: C.greenDark, align: "center", vAlign: "middle" });
  addShape(slide, "rect", 742, 596, 468, 42, { fill: C.soft, line: { fill: "none", width: 0 }, borderRadius: 4 });
  addText(slide, "软删除内容不进入正常列表、搜索和统计，日志与快照继续保留。", 754, 603, 444, 28, { fontSize: 16, color: C.muted, align: "center", vAlign: "middle" });
  setNotes(slide,
    "历史通过 seq 和 rev 回放指定版本，恢复通过追加新的差异操作完成，因此旧历史不会被覆盖。检索读取当前有效状态，导出把三类内容转换为 Markdown，统计从真实操作日志聚合。软删除内容不会进入正常列表、搜索和统计。",
    ["server/src/main/java/com/bishe/server/history/HistoryService.java", "server/src/main/java/com/bishe/server/web/ProductController.java", "artifacts/e2e-vue-final/10-collaboration-stats.png"]);
}

// 10. Automated verification
{
  const slide = newSlide(10, "双层自动化验证");
  addText(slide, "JUnit 验证算法与服务端契约，Playwright 验证真实用户链路。", 66, 138, 1100, 40, { fontSize: 25, bold: true });
  addLine(slide, 640, 196, 0, 426, C.line, 2);
  addLabel(slide, "JUnit / Maven clean", 66, 196, 420, { fontSize: 20, color: C.green });
  addMetric(slide, "43 / 43", "19 个测试套件全部通过", 66, 236, 500, { valueSize: 60, color: C.green });
  addBulletList(slide, [
    "engine 12 项，server 31 项",
    "8 个副本 × 3 轮 × 每轮 1000 个混合操作",
    "并发时钟碰撞 864 / 854 / 851 次，hash 仍一致",
    "失败 / 错误 / 跳过均为 0",
  ], 66, 372, 520, 212, { fontSize: 19, color: C.ink, spaceAfterPoints: 8 });

  addLabel(slide, "Playwright 真实浏览器", 682, 196, 430, { fontSize: 20, color: C.blue });
  addMetric(slide, "14 / 14", "owner / editor / viewer 三个隔离 context", 682, 228, 520, { valueSize: 60, color: C.blue });
  addText(slide, "离线 30003 ms 后自动重连并补齐\npageErrors / consoleErrors / HTTP 5xx = 0\n390 × 844 移动端无全局横向溢出", 682, 350, 520, 94, { fontSize: 18, color: C.ink, lineSpacing: 1.18 });
  const mobileAssets = [
    "artifacts/e2e-vue-final/12-mobile-document-390x844.png",
    "artifacts/e2e-vue-final/12-mobile-board-390x844.png",
    "artifacts/e2e-vue-final/12-mobile-kanban-390x844.png",
  ];
  const mobileNames = ["文档", "白板", "看板"];
  for (let index = 0; index < mobileAssets.length; index += 1) {
    const x = 688 + index * 170;
    await addImage(slide, mobileAssets[index], x, 472, 142, 154, { alt: `移动端${mobileNames[index]}截图`, fit: "cover", frameColor: C.line });
    addText(slide, mobileNames[index], x, 634, 142, 22, { fontSize: 15, color: C.muted, align: "center" });
  }
  setNotes(slide,
    "最终 clean 回归包含 19 个测试套件、43 项测试，全部通过。收敛压力测试把每轮 1000 个混合操作乱序投给 8 个副本，三轮 hash 均一致。Playwright 用三个隔离浏览器上下文覆盖三类应用、权限、历史、搜索、导出、统计和断线恢复，14 项全部通过。",
    ["docs/performance-report.md", "artifacts/test-reports/final-maven-20260920-1148/", "artifacts/e2e-vue-final/summary.json", ...mobileAssets]);
}

// 11. Native performance chart
{
  const slide = newSlide(11, "并发性能与可靠性");
  addText(slide, "最终唯一 clean 轮：50 客户端 P95 为 73.88 ms，三档均零丢失、零重复。", 66, 138, 1120, 40, { fontSize: 24, bold: true });
  addText(slide, "发送至 applied 的延迟分布", 68, 188, 680, 30, { fontSize: 19, bold: true, color: C.muted });
  const chart = slide.charts.add("bar", {
    position: { left: 60, top: 222, width: 770, height: 380 },
    categories: ["10 客户端", "50 客户端", "100 客户端"],
    series: [
      { name: "P50", values: [16.31, 46.30, 85.14], fill: C.blueLight, valuesFormatCode: "0.00" },
      { name: "P95", values: [31.04, 73.88, 115.37], fill: C.green, valuesFormatCode: "0.00" },
      { name: "P99", values: [34.00, 98.28, 129.71], fill: C.blue, valuesFormatCode: "0.00" },
    ],
    barOptions: { direction: "column", grouping: "clustered", gapWidth: 42 },
    hasLegend: true,
    legend: { position: "bottom", overlay: false, textStyle: { fontSize: 15, fill: C.muted } },
    xAxis: {
      visible: true,
      textStyle: { fontSize: 15, fill: C.muted },
      line: { style: "solid", fill: C.line, width: 1 },
      majorGridlines: null,
    },
    yAxis: {
      visible: true,
      title: { text: "延迟（ms）", textStyle: { fontSize: 15, fill: C.muted } },
      min: 0,
      max: 140,
      majorUnit: 20,
      numberFormatCode: "0",
      textStyle: { fontSize: 14, fill: C.muted },
      line: { style: "solid", fill: C.line, width: 1 },
      majorGridlines: { style: "solid", fill: C.line, width: 1 },
    },
    dataLabels: { showValue: true, position: "outEnd", textStyle: { fontSize: 13, fill: C.ink, bold: true } },
    chartFill: C.paper,
    chartLine: { style: "solid", fill: C.line, width: 1 },
    plotAreaFill: C.paper,
    plotAreaLine: { fill: "none", width: 0 },
  });
  applyPresentationChartFont(chart, { fontFamily: FONT });

  addShape(slide, "rect", 872, 210, 334, 164, { fill: C.orangeLight, line: { style: "solid", fill: C.orange, width: 1.5 }, borderRadius: 6 });
  addText(slide, "50 客户端 P95", 894, 230, 290, 28, { fontSize: 18, bold: true, color: C.orange, align: "center" });
  addText(slide, "73.88 ms", 894, 264, 290, 62, { fontSize: 48, bold: true, color: C.ink, align: "center", vAlign: "middle" });
  addText(slide, "门限 < 200 ms｜余量 126.12 ms", 894, 330, 290, 26, { fontSize: 16, color: C.orange, align: "center" });

  addLabel(slide, "吞吐", 872, 408, 160, { fontSize: 18, color: C.green });
  addText(slide, "10 客户端    473 ops/s\n50 客户端    988 ops/s\n100 客户端  1,151 ops/s", 872, 446, 334, 112, { fontSize: 20, color: C.ink, lineSpacing: 1.25 });
  addShape(slide, "rect", 872, 570, 334, 50, { fill: C.greenLight, line: { fill: "none", width: 0 }, borderRadius: 5 });
  addText(slide, "lost = 0    duplicate = 0", 886, 580, 306, 30, { fontSize: 20, bold: true, color: C.greenDark, align: "center", vAlign: "middle" });
  addText(slide, "100 客户端为本机容量观测，不作为生产集群承诺。", 68, 628, 760, 28, { fontSize: 16, color: C.muted });
  setNotes(slide,
    "最终唯一 clean 轮在单个真实房间中分别连接 10、50、100 个 WebSocket 客户端，每个客户端连续发送 20 条操作。P95 分别为 31.04、73.88 和 115.37 毫秒；吞吐分别为 473、988 和 1151 ops/s。三档 lost 和 duplicate 都为零。100 客户端仅作为本机容量观测。",
    ["docs/performance-report.md", "artifacts/test-reports/final-maven-20260920-1148/server/TEST-com.bishe.server.ws.ConcurrentLoadTest.xml"]);
}

// 12. Conclusion
{
  const slide = newSlide(12, "完成结果与实现边界");
  addText(slide, "同一套一致性内核完成三类协同应用，并由算法、浏览器与负载测试共同验证。", 66, 138, 1120, 52, { fontSize: 25, bold: true });
  const appNodes = [
    addNode(slide, "协同文档", 70, 230, 176, 60, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 20 }),
    addNode(slide, "协同白板", 70, 314, 176, 60, { fill: C.orangeLight, stroke: C.orange, color: C.orange, fontSize: 20 }),
    addNode(slide, "协同看板", 70, 398, 176, 60, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 20 }),
  ];
  const core = addNode(slide, "Element + Op\nLamport + LWW\n墓碑与日志", 350, 274, 244, 142, { fill: C.charcoal, stroke: C.charcoal, color: C.paper, fontSize: 23 });
  const proofNodes = [
    addNode(slide, "收敛\n8 副本乱序 hash 一致", 710, 224, 250, 82, { fill: C.greenLight, stroke: C.green, color: C.greenDark, fontSize: 18 }),
    addNode(slide, "可用\nPlaywright 14 / 14", 710, 324, 250, 82, { fill: C.blueLight, stroke: C.blue, color: C.blueDark, fontSize: 18 }),
    addNode(slide, "可靠\n三档零丢失、零重复", 710, 424, 250, 82, { fill: C.soft, stroke: C.faint, fontSize: 18 }),
  ];
  appNodes.forEach((node) => connect(slide, node, core, { color: C.green, kind: "elbow" }));
  proofNodes.forEach((node) => connect(slide, core, node, { color: C.blue, kind: "elbow" }));

  addShape(slide, "rect", 986, 218, 222, 294, { fill: C.paper, line: { style: "solid", fill: C.line, width: 1 }, borderRadius: 6 });
  addLabel(slide, "实现边界", 1010, 238, 174, { fontSize: 20, color: C.orange });
  addBulletList(slide, [
    "文本冲突粒度为段落字段",
    "白板仅包含结构化卡片",
    "当前采用单服务实例协调",
  ], 998, 292, 198, 198, { fontSize: 16, color: C.ink, marginLeftPoints: 14, hangingPoints: 7, spaceAfterPoints: 10 });
  addLine(slide, 66, 556, 1140, 0, C.line, 1);
  addText(slide, "谢谢各位老师，请批评指正", 66, 584, 1140, 52, { fontSize: 36, bold: true, color: C.greenDark, align: "center", vAlign: "middle" });
  setNotes(slide,
    "本项目完成了一个可运行的 Java 协同一致性内核，并用文档、白板和看板验证统一建模与复用路径。平台侧认证、权限、持久化、历史、检索、导出和统计形成闭环。文本采用段落级字段 LWW，白板面向结构化卡片，当前部署采用单实例协调。",
    ["D:/bishe/docs/20235102034-柯佳伟-任务书.docx", "docs/architecture.md", "docs/performance-report.md", "artifacts/e2e-vue-final/summary.json"]);
}

const stagingDir = path.join(buildDir, ".codex-finalizer");
await fs.mkdir(stagingDir, { recursive: true });
const candidatePath = path.join(stagingDir, "candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
await patchPresentationPackage(candidatePath);

const requirements = {
  explicitTotalSlideCount: TOTAL_SLIDES,
  requiredNativeTableOwnerSlides: [8],
  requiredNativeChartOwnerSlides: [11],
  approvedSourceFigureExceptionSlides: [],
  materializeLiteralChartWorkbooks: true,
  tableArithmeticContracts: [],
};
const fontPolicy = {
  basis: "design",
  families: [FONT],
  scriptFonts: { ea: FONT },
};
const receiptPath = path.join(buildDir, `毕业设计答辩PPT-${revision}.validation.json`);
const result = await finalizePresentation({
  ...requirements,
  workspaceDir,
  candidatePath,
  finalPath,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, "container_tools", "inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR, "container_tools", "inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-aspect", "16:9",
    "--expected-slide-size-emu", EXPECTED_SIZE_EMU,
    "--validate-bullet-geometry",
    "--validate-heading-fit",
    "--validate-heading-punctuation",
    "--cover-role", "cover",
    "--cover-word-limit", "50",
    "--require-native-table-slide", "8",
  ],
  requiredNativeTableOwnerSlides: requirements.requiredNativeTableOwnerSlides,
  fontPolicy,
  verifyArtifactToolImport: true,
  receiptPath,
});

console.log(JSON.stringify({
  revision,
  finalPath: result.finalPath,
  receiptPath: result.receiptPath,
  finalSha256: result.finalSha256,
  byteCount: result.byteCount,
  nativeChartValidation: result.nativeChartValidation,
  fontSelection: result.fontSelection,
}, null, 2));
