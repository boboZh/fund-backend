const DISCLAIMER_RE = /免责声明|免责条款|法律声明|重要声明|信息披露|特别声明/;
const PAGE_NO_RE = /^(?:第\s*)?\d{1,3}(?:\s*页)?$/;

// 页脚上的「3」「第 2 页」才是页码。左栏里的总市值 203 也是三位数字，但不能按页码丢掉。
const isPageNumber = (line, key) => {
  if (!PAGE_NO_RE.test(key)) return false;
  if (/页/.test(key) || key.startsWith("第")) return true;
  const height = line.pageHeight || 800;
  return line.y <= height * 0.08 || line.y >= height * 0.92;
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
};

const normalizeItems = (items) =>
  items
    .filter((item) => item.str && String(item.str).trim())
    .map((item) => ({
      text: String(item.str),
      x: item.x,
      y: item.y,
      width: item.width || 0,
      height: item.height || 10,
    }));

const groupRows = (items) => {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  sorted.forEach((item) => {
    const last = rows[rows.length - 1];
    const threshold = Math.max(item.height, last ? last.height : 0) * 0.45;
    if (last && Math.abs(last.y - item.y) <= threshold) {
      last.items.push(item);
      return;
    }
    rows.push({ y: item.y, height: item.height, items: [item] });
  });
  return rows;
};

const rowGap = (items) => {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1];
    const gap = sorted[index].x - (prev.x + prev.width);
    gaps.push({ gap, at: sorted[index].x });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  return {
    maxGap: gaps[0] ? gaps[0].gap : 0,
    gapAt: gaps[0] ? gaps[0].at : null,
    secondGap: gaps[1] ? gaps[1].gap : 0,
    wideCount: gaps.filter((item) => item.gap >= 8).length,
    sorted,
  };
};

// 双栏页中间有一条明显宽于表格列距的竖直空档。表格里有很多差不多宽的列距，不能当成栏。
const findGutter = (rows, pageWidth, fontSize) => {
  if (!pageWidth) return null;
  const minGap = Math.max(16, fontSize * 1.4);
  const votes = [];
  rows.forEach((row) => {
    const { maxGap, gapAt, secondGap, wideCount } = rowGap(row.items);
    // 一行里有多条接近的空隙，是表格列，不是左右栏
    if (!gapAt || maxGap < minGap || wideCount >= 3) return;
    if (secondGap > 0 && maxGap < secondGap * 2.2) return;
    if (gapAt < pageWidth * 0.22 || gapAt > pageWidth * 0.78) return;
    votes.push({ x: gapAt, width: maxGap });
  });
  if (votes.length < 2) return null;
  votes.sort((a, b) => a.x - b.x);
  const clusters = [];
  votes.forEach((vote) => {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(vote.x - last.x) <= 28) {
      last.votes.push(vote);
      last.x =
        last.votes.reduce((sum, item) => sum + item.x, 0) / last.votes.length;
      last.width = Math.max(last.width, vote.width);
      return;
    }
    clusters.push({ x: vote.x, width: vote.width, votes: [vote] });
  });
  clusters.sort((a, b) => b.votes.length - a.votes.length || b.width - a.width);
  const best = clusters[0];
  const second = clusters[1];
  if (best.votes.length < 2 || best.width < minGap) return null;
  if (
    second &&
    best.votes.length < second.votes.length * 1.5 &&
    best.width < second.width * 1.4
  ) {
    return null;
  }
  return best.x;
};

const joinPieces = (pieces, y) => {
  const ordered = [...pieces].sort((a, b) => a.x - b.x);
  let text = "";
  const gaps = [];
  ordered.forEach((piece, index) => {
    const prev = ordered[index - 1];
    if (prev) {
      const gap = piece.x - (prev.x + prev.width);
      gaps.push(gap);
      const font = Math.max(prev.height, piece.height, 8);
      if (gap > font * 0.45) {
        const numeric =
          /[\d%]|[AEae]$/.test(prev.text) || /^[\d(（]/.test(piece.text.trim());
        text += numeric ? " | " : " ";
      }
    }
    text += piece.text;
  });
  return {
    text: text
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\|\s*/g, " | ")
      .trim(),
    x: ordered[0].x,
    right: ordered[ordered.length - 1].x + ordered[ordered.length - 1].width,
    y,
    fontSize: median(ordered.map((piece) => piece.height)) || 10,
    gaps,
    role: "body",
  };
};

// 把带坐标的碎片拼成一行行文字。
// 先按栏读完再读下一栏。同一行高上的左栏数字不能插进右栏句子里。
const orderReadingLines = (items, pageWidth) => {
  const normalized = normalizeItems(items);
  if (!normalized.length) return [];
  const fontSize = median(normalized.map((item) => item.height)) || 10;
  const rows = groupRows(normalized);
  const gutterX = findGutter(rows, pageWidth, fontSize);
  const minGap = Math.max(16, fontSize * 1.4);
  const lines = [];
  let leftBuf = [];
  let rightBuf = [];

  const flushColumns = () => {
    if (!leftBuf.length && !rightBuf.length) return;
    const medianWidth = median(leftBuf.map((line) => line.right - line.x));
    const asSummary =
      Boolean(pageWidth) && medianWidth > 0 && medianWidth < pageWidth * 0.36;
    leftBuf.forEach((line) => {
      lines.push({ ...line, role: asSummary ? "side" : "body" });
    });
    lines.push(...rightBuf);
    leftBuf = [];
    rightBuf = [];
  };

  rows.forEach((row) => {
    const { maxGap, gapAt, sorted } = rowGap(row.items);
    if (gutterX == null) {
      const line = joinPieces(sorted, row.y);
      if (line.text) lines.push(line);
      return;
    }
    const left = sorted.filter((piece) => piece.x + piece.width / 2 < gutterX);
    const right = sorted.filter(
      (piece) => piece.x + piece.width / 2 >= gutterX
    );
    const splits =
      maxGap >= minGap &&
      gapAt != null &&
      Math.abs(gapAt - gutterX) <= 32 &&
      left.length > 0 &&
      right.length > 0;
    const lastY =
      leftBuf.length || rightBuf.length
        ? Math.min(
            leftBuf.length ? leftBuf[leftBuf.length - 1].y : Infinity,
            rightBuf.length ? rightBuf[rightBuf.length - 1].y : Infinity
          )
        : null;
    // 栏内换行间距不大。拉开一大截之后出现的单侧文字，是下一节正文，不再并进上一栏。
    if (lastY != null && lastY - row.y > fontSize * 5) flushColumns();
    if (splits) {
      if (left.length) {
        const line = joinPieces(left, row.y);
        if (line.text) leftBuf.push(line);
      }
      if (right.length) {
        const line = joinPieces(right, row.y);
        if (line.text) rightBuf.push(line);
      }
      return;
    }
    const onlyLeft = left.length > 0 && right.length === 0;
    const onlyRight = right.length > 0 && left.length === 0;
    if ((onlyLeft || onlyRight) && (leftBuf.length || rightBuf.length)) {
      const line = joinPieces(onlyLeft ? left : right, row.y);
      if (line.text) (onlyLeft ? leftBuf : rightBuf).push(line);
      return;
    }
    flushColumns();
    const line = joinPieces(sorted, row.y);
    if (line.text) lines.push(line);
  });
  flushColumns();
  return lines.filter((line) => line.text);
};

const itemsToLines = (items) => orderReadingLines(items, 0);

const TABLE_LABEL_RE =
  /预测指标|主营收入|营业收入|归母净利润|净利润|增长率|摊薄每股|每股收益|基本数据|当前股价|总市值|总股本|流通股本/;

const isTableLine = (line) => {
  const text = line.text || "";
  const yearTokens = text.match(/20\d{2}[AE]/gi) || [];
  if (yearTokens.length >= 2) return true;
  const numbers = text.match(/\d+(?:\.\d+)?%?/g) || [];
  if (text.includes("|") && numbers.length >= 2) return true;
  if (numbers.length >= 3) return true;
  if (TABLE_LABEL_RE.test(text) && numbers.length >= 1) return true;
  const wideGaps = (line.gaps || []).filter(
    (gap) => gap > (line.fontSize || 10)
  );
  return wideGaps.length >= 2 && numbers.length >= 2;
};
// 去掉每页上重复出现的页眉、页脚和页码，避免这些套话在后面的切块和检索里占位置。
const stripChrome = (pages) => {
  const counts = new Map();
  pages.forEach((lines) => {
    const seen = new Set();
    lines.forEach((line) => {
      const key = line.text.replace(/\s/g, "");
      if (!key || key.length > 30 || seen.has(key)) return;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  const repeated = new Set(
    [...counts.entries()].filter(([, count]) => count >= 3).map(([key]) => key)
  );

  const dropped = [];
  const cleaned = pages.map((lines, index) => {
    const page = index + 1;
    return lines.filter((line) => {
      const key = line.text.replace(/\s/g, "");
      if (isPageNumber(line, key)) {
        dropped.push({ page, reason: "页码", text: line.text });
        return false;
      }
      if (repeated.has(key)) {
        dropped.push({ page, reason: "页眉页脚", text: line.text });
        return false;
      }
      return true;
    });
  });
  return { cleaned, dropped };
};
// 把已经排好序的一行行文字收成段落。PDF 里没有段落标记，一段话常常因为换行被拆成好几行，这里用行距、句末标点和字号把它们重新拼回去。
const linesToParagraphs = (lines, page) => {
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  // 先量出这一页的正常行距。 相邻两行的 y 差就是行距。取这些行距的中位数 medianGap，作为「正常换行」的基准。这一栏最宽的那一行当作栏宽。
  const medianGap =
    median(gaps) || median(lines.map((line) => line.fontSize)) * 1.2;
  const columnWidth = Math.max(...lines.map((line) => line.right - line.x), 1);
  const tableFlags = lines.map((line) => isTableLine(line));
  for (let index = 1; index < tableFlags.length - 1; index += 1) {
    if (
      !tableFlags[index] &&
      tableFlags[index - 1] &&
      tableFlags[index + 1] &&
      lines[index].text.length <= 24
    ) {
      tableFlags[index] = true;
    }
  }
  const paragraphs = [];
  let buffer = [];
  let bufferIsTable = false;
  // 从上往下攒进缓冲区，遇到段落边界就封存一块。表格行单独成一块，不和正文粘在一起。
  const flush = () => {
    if (!buffer.length) return;
    paragraphs.push({
      page,
      text: buffer.map((line) => line.text).join(bufferIsTable ? "\n" : ""),
      fontSize: Math.max(...buffer.map((line) => line.fontSize)),
      kind: bufferIsTable ? "table" : "text",
      lineCount: buffer.length,
    });
    buffer = [];
    bufferIsTable = false;
  };

  lines.forEach((line, index) => {
    const isDisclaimerLine =
      line.text.length <= 20 &&
      (DISCLAIMER_RE.test(line.text) || line.text === "目录");
    if (isDisclaimerLine) {
      flush();
      buffer.push(line);
      flush();
      return;
    }
    const bareNumber = /^[\d,.\s%|]+$/.test(line.text);
    if (!buffer.length) {
      buffer.push(line);
      bufferIsTable = tableFlags[index];
      if (bareNumber && !tableFlags[index]) flush();
      return;
    }
    const prev = buffer[buffer.length - 1];
    const gap = prev.y - line.y;
    const prevEndsSentence = /[。！？]$/.test(prev.text);
    const prevShort = prev.right - prev.x < columnWidth * 0.75;
    const nextIsHeading =
      line.fontSize > prev.fontSize * 1.15 &&
      line.text.length <= 40 &&
      !/[。！？]$/.test(line.text);
    const tableChanged = bufferIsTable !== tableFlags[index];
    if (
      gap > medianGap * 1.6 ||
      (prevEndsSentence && prevShort && !bufferIsTable) ||
      nextIsHeading ||
      tableChanged ||
      (bareNumber && !tableFlags[index])
    ) {
      flush();
    }
    buffer.push(line);
    bufferIsTable = tableFlags[index];
    if (bareNumber && !tableFlags[index]) flush();
    if (index === lines.length - 1) flush();
  });
  if (buffer.length) flush();
  return paragraphs;
};

const isHeadingParagraph = (paragraph, bodySize) =>
  paragraph.kind === "text" &&
  paragraph.lineCount === 1 &&
  paragraph.text.length <= 40 &&
  !/[。！？]$/.test(paragraph.text) &&
  paragraph.fontSize >= bodySize * 1.15;

// 给这些段落标上小节标题，并丢掉免责声明。
const attachHeadings = (paragraphs) => {
  const bodySize =
    median(
      paragraphs
        .filter((paragraph) => paragraph.kind === "text")
        .map((paragraph) => paragraph.fontSize)
    ) || 10;
  let heading = null;
  let skipping = false;
  const kept = [];
  const dropped = [];

  paragraphs.forEach((paragraph) => {
    const looksLikeDisclaimer =
      paragraph.text.length <= 40 &&
      (DISCLAIMER_RE.test(paragraph.text) || paragraph.text === "目录");
    if (looksLikeDisclaimer) {
      skipping = true;
      dropped.push({
        page: paragraph.page,
        reason: paragraph.text === "目录" ? "目录" : "免责声明",
        text: paragraph.text,
      });
      heading = null;
      return;
    }
    if (isHeadingParagraph(paragraph, bodySize)) {
      skipping = false;
      heading = paragraph.text;
      return;
    }
    if (skipping) {
      dropped.push({
        page: paragraph.page,
        reason: "免责声明",
        text: paragraph.text.slice(0, 80),
      });
      return;
    }
    kept.push({
      page: paragraph.page,
      text: paragraph.text,
      kind: paragraph.kind,
      heading,
    });
  });

  if (!kept.length && paragraphs.length) {
    return {
      paragraphs: paragraphs.map((paragraph) => ({
        page: paragraph.page,
        text: paragraph.text,
        kind: paragraph.kind === "table" ? "table" : "text",
        heading: null,
      })),
      dropped,
    };
  }
  return { paragraphs: kept, dropped };
};

const buildDocument = (pages) => {
  // 把带坐标的碎片拼成一行行文字。
  const pageLines = pages.map((page) =>
    orderReadingLines(page.items, page.width).map((line) => ({
      ...line,
      page: page.pageNumber,
      pageHeight: page.height || 800,
    }))
  );
  // 前两页里用来识别研报信息的原始行，不参与切块
  const metaLines = pageLines
    .slice(0, 2)
    .flat()
    .slice(0, 80)
    .map((line) => ({ text: line.text, fontSize: line.fontSize }));

  // 去掉每页上重复出现的页眉、页脚和页码
  const { cleaned, dropped: chromeDropped } = stripChrome(pageLines);
  const paragraphs = [];
  const sectionDropped = [];

  // 正文收成段落
  cleaned.forEach((lines, index) => {
    const pageNumber = index + 1;
    const side = lines.filter((line) => line.role === "side");
    const body = lines.filter((line) => line.role !== "side");
    if (side.length) {
      paragraphs.push({
        page: pageNumber,
        text: side.map((line) => line.text).join("\n"),
        kind: "summary",
        heading: "核心数据",
      });
    }
    const bodyParagraphs = linesToParagraphs(body, pageNumber);
    const attached = attachHeadings(bodyParagraphs);
    paragraphs.push(...attached.paragraphs);
    sectionDropped.push(...attached.dropped);
  });

  const charCount = paragraphs.reduce(
    (sum, paragraph) => sum + paragraph.text.length,
    0
  );
  return {
    pageCount: pages.length,
    paragraphs: paragraphs.filter((paragraph) => paragraph.text.trim()),
    dropped: [...chromeDropped, ...sectionDropped].slice(0, 50),
    metaLines,
    charCount,
  };
};

module.exports = {
  buildDocument,
  itemsToLines,
  orderReadingLines,
  isTableLine,
};
