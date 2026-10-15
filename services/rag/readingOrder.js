const { OpenAI } = require("openai");

// 改提示词或拼接规则时加 1，旧的版面缓存就会作废并重新请求模型。
const LAYOUT_VERSION = 2;

const ROLES = new Set(["sidebar", "heading", "paragraph", "table"]);
const BOILERPLATE_RE =
  /免责声明|免责条款|法律声明|重要声明|信息披露|特别声明|不承担任何法律责任|本报告版权仅为/;
const NUMBER_RE = /\d+(?:\.\d+)?%?/g;

const SYSTEM_PROMPT = `你是研报版面的阅读顺序整理器。用户给出一页 PDF 里已经抽出的文本碎片，每条有 id、x、y 和原文 t。
你只负责分组和排序。禁止改写、翻译、计算、补全或复述任何文字。JSON 里不要出现原文字段。

坐标：x 越大越靠右，y 越大越靠上。y 相差不超过 3 的碎片在同一行。

只输出一个 JSON 对象：
{"blocks":[{"role":"sidebar","lines":[[1,2],[3]]},{"role":"heading","lines":[[4]]},{"role":"paragraph","lines":[[5,6],[7]]},{"role":"table","lines":[[8,9,10],[11,12,13]]}]}

规则：
1. lines 里只能出现输入中的 id。不要输出 t、text 或任何数字的誊写。
2. 每个 id 最多出现一次。页眉、页脚、页码、目录、免责声明、免责条款不要放进 blocks。证券投资评级说明和其中的评级表格要保留，买入、增持对应的涨幅不能丢掉。
3. 左侧或页首的数据卡（评级、股价、市值、股本、成交额）整块放进一个 sidebar，先输出 sidebar，再输出右栏。
4. 同一行上如果既有左侧短数字、又有右侧句子，数字放进 sidebar，句子放进 paragraph。例如 id 8 是「当前股价（元）」、id 9 是「119.81」、id 10 是「方向发展，」，则 sidebar 使用 [8,9]，paragraph 使用 [10]，不要把 9 和 10 放进同一个 paragraph。
5. 右栏按自然段拆开，一个自然段一个 paragraph。段内每一视觉行是 lines 里的一个数组，行与行按阅读顺序排列。
6. 小节标题用 heading。
7. 有表头和多列数字的表用一个 table。每一视觉行是一个数组，单元格从左到右。不要把同一张表拆成多个 table，也不要把表格行并进正文。
8. 折线图的坐标刻度、图例、资料来源不要放进 blocks。`;

const idOf = (value) => {
  if (typeof value === "number" || typeof value === "string")
    return Number(value);
  if (value && typeof value === "object" && value.id != null)
    return Number(value.id);
  return NaN;
};

// 规范化模型返回的数据格式
const normalizeLines = (block) => {
  const source = Array.isArray(block?.lines)
    ? block.lines
    : Array.isArray(block?.ids)
      ? [block.ids]
      : [];
  const rows = source.every((item) => !Array.isArray(item))
    ? [source]
    : source.filter(Array.isArray);
  return rows
    .map((row) => row.map(idOf).filter((id) => Number.isInteger(id)))
    .filter((row) => row.length);
};

const normalizeBlocks = (blocks) => {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .map((block) => ({
      role: ROLES.has(block?.role) ? block.role : "paragraph",
      lines: normalizeLines(block),
    }))
    .filter((block) => block.lines.length);
};

const parseBlocks = (content) => {
  const text = String(content || "").trim();
  if (!text) throw new Error("模型没有返回内容");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON");
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error("模型返回的 JSON 无法解析");
  }
  if (!Array.isArray(data.blocks)) throw new Error("模型返回缺少 blocks");
  return data.blocks;
};

// PDF 会把字距展开成空格，「2 0 2 6」「算 力」仍是原文里的数字和汉字，收紧后才读得成一句。英文单词之间的空格留下。
const cleanText = (text) =>
  String(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "")
    .replace(/(?<=\d)\s+(?=\d)/g, "")
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[，。、；：！？（）《》])/g, "")
    .replace(/(?<=[，。、；：！？])\s+(?=[\u4e00-\u9fff])/g, "");

const indexItems = (items) =>
  items
    .filter((item) => item.str && String(item.str).trim())
    .map((item, index) => ({
      id: index + 1,
      text: cleanText(item.str),
      x: item.x,
      y: item.y,
      width: item.width || 0,
    }));

// 分隔看坐标空隙，不看模型写的文字。紧挨着的「2026」「-09-30」保持原样，隔开的单元格才加竖线。
const joinPieces = (pieces, role) => {
  const ordered = [...pieces].sort((a, b) => a.x - b.x || b.y - a.y);
  let text = "";
  ordered.forEach((piece, index) => {
    const prev = ordered[index - 1];
    if (prev) {
      const gap = piece.x - (prev.x + prev.width);
      if (role === "paragraph" || role === "heading") {
        const digitsTouch = /\d$/.test(prev.text) && /^\d/.test(piece.text);
        const ascii =
          /[A-Za-z0-9]$/.test(prev.text) && /^[A-Za-z0-9]/.test(piece.text);
        // 2022 和 650 贴在一起会被读成 2022650，碎片之间的数字必须隔开
        if (digitsTouch || (ascii && gap > 2)) text += " ";
      } else if (gap > 8) {
        text += " | ";
      }
    }
    text += piece.text;
  });
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\|\s*/g, " | ")
    .trim();
};

const numbersOf = (text) => text.match(NUMBER_RE) || [];

// 拼出来的数字必须能在本次用到的原文里找到。模型若另写了一份数字，调用方不能把它拼进来。
const assertNumbersFromSource = (text, source) => {
  const compact = source.replace(/\s/g, "");
  numbersOf(text).forEach((num) => {
    const bare = num.endsWith("%") ? num.slice(0, -1) : num;
    if (!compact.includes(num) && !compact.includes(bare)) {
      throw new Error(`出现了原文里没有的数字 ${num}`);
    }
  });
};

/**
 * 入参 items 已带 id；blocks 是模型返回的分组，只认 lines 里的 id。
 * 出参 paragraphs 的 text 只由原文碎片拼接。模型附带的 text 字段会被丢掉。
 * 步骤：先把 sidebar 占用的 id 留住；再按块顺序取 id，同一行按 x 从左到右用原文拼接。
 */
const assemblePage = (items, rawBlocks, pageNumber) => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const blocks = normalizeBlocks(rawBlocks);
  const used = new Set();
  const sidebarIds = new Set();
  blocks.forEach((block) => {
    if (block.role !== "sidebar") return;
    block.lines.flat().forEach((id) => {
      if (byId.has(id)) sidebarIds.add(id);
    });
  });

  const take = (ids, role) => {
    const pieces = [];
    ids.forEach((id) => {
      if (!byId.has(id) || used.has(id)) return;
      if (role !== "sidebar" && sidebarIds.has(id)) return;
      used.add(id);
      pieces.push(byId.get(id));
    });
    return pieces;
  };

  const blockText = (block) => {
    const lines = block.lines
      .map((ids) => {
        const pieces = take(ids, block.role);
        return {
          text: joinPieces(pieces, block.role),
          source: pieces.map((piece) => piece.text).join(""),
        };
      })
      .filter((line) => line.text);
    const joiner =
      block.role === "paragraph" || block.role === "heading" ? "" : "\n";
    let text = "";
    lines.forEach((line) => {
      if (text && joiner) text += joiner;
      else if (text && /\d$/.test(text) && /^\d/.test(line.text)) text += " ";
      text += line.text;
    });
    text = text.trim();
    assertNumbersFromSource(text, lines.map((line) => line.source).join(""));
    return text;
  };

  const sidebarText = blocks
    .filter((block) => block.role === "sidebar")
    .map(blockText)
    .filter(Boolean)
    .join("\n");

  const paragraphs = [];
  let heading = null;
  let placedSidebar = false;
  blocks.forEach((block) => {
    if (block.role === "sidebar") {
      if (!placedSidebar && sidebarText) {
        paragraphs.push({
          page: pageNumber,
          text: sidebarText,
          kind: "summary",
          heading: "核心数据",
        });
        placedSidebar = true;
      }
      return;
    }
    if (block.role === "heading") {
      const text = blockText(block);
      if (text) heading = text.slice(0, 80);
      return;
    }
    const text = blockText(block);
    if (!text) return;
    paragraphs.push({
      page: pageNumber,
      text,
      kind: block.role === "table" ? "table" : "text",
      heading,
    });
  });
  const dropped = items
    .filter((item) => !used.has(item.id))
    .map((item) => ({
      page: pageNumber,
      reason: "未纳入阅读顺序",
      text: item.text.slice(0, 80),
    }));

  return {
    paragraphs: paragraphs.filter((paragraph) => paragraph.text.trim()),
    dropped,
  };
};

const pagePrompt = (page, items) => {
  const payload = items.map((item) => ({
    id: item.id,
    x: Math.round(item.x),
    y: Math.round(item.y),
    t: item.text,
  }));
  return `页码 ${page.pageNumber}，页面宽 ${Math.round(page.width || 0)}，高 ${Math.round(page.height || 0)}。y 越大越靠上。\n${JSON.stringify(payload)}`;
};

const tocTitle = (value) => String(value || "").replace(/[\s#■▌]/g, "");
const TOC_LEADER_RE =
  /(?:\.{3,}|．{3,}|·{3,}|‧{3,}|…{2,}|⋯{2,}|(?:\.\s*){3,})\s*\d{1,3}/;

const hasTocLeader = (paragraph) => {
  const title = tocTitle(paragraph.heading);
  if (title === "目录" || (title.endsWith("目录") && title.length <= 6))
    return true;
  return TOC_LEADER_RE.test(paragraph.text || "");
};

// 目录可能跨页，后面几页没有「目录」标题。点线后面的页码就能认出条目；换行拆开的半句和它留在同一页，一并去掉。
const dropToc = (paragraphs) => {
  const leader = paragraphs.map(hasTocLeader);
  const drop = leader.slice();
  paragraphs.forEach((paragraph, index) => {
    if (drop[index]) return;
    const text = paragraph.text || "";
    const fragment = text.length <= 120 && !/[。！？]/.test(text);
    if (!fragment) return;
    const beside = [index - 1, index + 1].some((other) => {
      const neighbor = paragraphs[other];
      return neighbor && leader[other] && neighbor.page === paragraph.page;
    });
    if (beside) drop[index] = true;
  });

  const kept = [];
  const dropped = [];
  paragraphs.forEach((paragraph, index) => {
    if (!drop[index]) {
      kept.push(paragraph);
      return;
    }
    dropped.push({
      page: paragraph.page,
      reason: "目录",
      text: paragraph.text.slice(0, 80),
    });
  });
  return { paragraphs: kept, dropped };
};

// 免责条款是律所套话，从这里起到文末丢掉。评级说明要留下，否则「买入」对应的涨幅无法检索。
const dropTrailingBoilerplate = (paragraphs) => {
  const kept = [];
  const dropped = [];
  let skipping = false;
  paragraphs.forEach((paragraph) => {
    const title = paragraph.heading || "";
    if (BOILERPLATE_RE.test(title) || BOILERPLATE_RE.test(paragraph.text))
      skipping = true;
    if (skipping) {
      dropped.push({
        page: paragraph.page,
        reason: "免责声明",
        text: paragraph.text.slice(0, 80),
      });
      return;
    }
    kept.push(paragraph);
  });
  return { paragraphs: kept, dropped };
};

const createClient = () => {
  if (!process.env.AI_API_KEY) {
    throw new Error("未配置 AI_API_KEY，无法用模型整理版面");
  }
  return new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || "https://api.deepseek.com/v1",
    timeout: 90_000,
  });
};

const requestPageBlocks = async (client, page, items) => {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        model: process.env.AI_MODEL || "deepseek-chat",
        temperature: 0,
        max_tokens: 8192,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: pagePrompt(page, items) },
        ],
      });
      return parseBlocks(completion.choices?.[0]?.message?.content);
    } catch (err) {
      lastError = err;
      if (err.status === 401 || err.status === 402) break;
    }
  }
  throw new Error(`第 ${page.pageNumber} 页版面整理失败：${lastError.message}`);
};

/**
 * 入参 pages 来自 extractPdfPages。client 可注入，便于测试；onPage 用于回写进度。
 * 出参 paragraphs 按页、按阅读顺序排列，文本只含原文。
 * 步骤：逐页把碎片和坐标交给模型，模型返回 id 分组，再按 id 拼侧栏、段落和表格。
 */
const orderDocument = async (pages, { client, onPage } = {}) => {
  const llm = client || createClient();
  const paragraphs = [];
  const dropped = [];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (onPage) await onPage(page.pageNumber, pages.length);
    const items = indexItems(page.items);
    if (!items.length) continue;
    const blocks = await requestPageBlocks(llm, page, items);
    const assembled = assemblePage(items, blocks, page.pageNumber);
    paragraphs.push(...assembled.paragraphs);
    dropped.push(...assembled.dropped);
  }
  const withoutToc = dropToc(paragraphs);
  const trimmed = dropTrailingBoilerplate(withoutToc.paragraphs);
  const charCount = trimmed.paragraphs.reduce(
    (sum, paragraph) => sum + paragraph.text.length,
    0
  );
  return {
    version: LAYOUT_VERSION,
    pageCount: pages.length,
    paragraphs: trimmed.paragraphs,
    dropped: [...dropped, ...withoutToc.dropped, ...trimmed.dropped].slice(
      0,
      50
    ),
    charCount,
  };
};

module.exports = {
  LAYOUT_VERSION,
  parseBlocks,
  indexItems,
  assemblePage,
  dropTrailingBoilerplate,
  dropToc,
  orderDocument,
  assertNumbersFromSource,
};
