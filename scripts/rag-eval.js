const { retrieve } = require("../services/rag/retrieve");

// 有答案的题算 recall。拒答题不进分母，用来看重排分能不能和有答案的题分开。
// 用法: node scripts/rag-eval.js <user_id> [minScore]
// 这套题上，minScore 取 [0.0134, 0.7419]：0.0134 起无答案题留 0 条，超过 0.7419 会丢掉最弱的正确段。
const ownerId = Number(process.argv[2]);
const minScoreArg = process.argv[3];
const LIMIT = 5;
const KS = [1, 3, 5];

const questions = [
  {
    question: "煤炭业务方面，周边煤化工项目带动下的富油煤需求是否增长",
    stockCode: "600256",
    mustContain: "富油煤需求增长",
  },
  {
    question: "煤炭业务营收额是多少",
    stockCode: "600256",
    mustContain: "80.54",
  },
  {
    question: "资管业务“相寓”品牌业务发展形势如何",
    stockCode: "000560",
    mustContain: "在管房源持续增长",
  },
  {
    question: "2025归母净利",
    stockCode: "000560",
    mustContain: "-97",
  },
  {
    question: "全球高速连接器业务现状",
    stockCode: "300843",
    mustContain: "泰科、安费诺、莫仕",
  },
  {
    question: "2025流动负债合计",
    stockCode: "300843",
    mustContain: "970",
  },
  {
    question: "广汇能源公司简介，成立时间及规模",
    stockCode: "600256",
    mustContain: "1999年4月",
  },
  {
    question: "随着AI大模型参数的增长，数据中心服务器架构发生了怎样的演变？",
    mustContain: "由单机柜向超节点集群",
  },
  {
    question:
      "2026H1期间，公司的研发投入金额及资本开支金额分别占营业收入的比重是多少？",
    mustContain: "1.05%",
  },
  {
    question: "公司目前的在产煤矿项目均分布在哪个具体地区？",
    mustContain: "新疆哈密地区",
  },
  // 库里没有能回答这三题的文档。重排分用来和有答案的题对照，不计入 recall。
  {
    question: "国产 DRAM 投资逻辑-长鑫科技",
    stockCode: "",
    mustContain: "DRAM 龙头",
    reject: true,
  },
  {
    question: "高代际产品体系包含哪些板块",
    stockCode: "",
    mustContain: "LPDDR5/5X",
    reject: true,
  },
  {
    question: "2025A营业收入",
    stockCode: "688825",
    mustContain: "617.99",
    reject: true,
  },
  {
    question: "长鑫科技的投资逻辑",
    reject: true,
  },
];

// 数字单独成段才算命中，避免 970 撞上 1970、-97 撞上 -970。
const containsFact = (content, fact) => {
  if (!content) return false;
  if (/^-?\d+(?:\.\d+)?$/.test(fact)) {
    const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`).test(content);
  }
  const compact = (text) => String(text).replace(/\s+/g, "");
  return compact(content).includes(compact(fact));
};

const RUNS = [
  { mode: "vector", rerank: false, label: "向量" },
  { mode: "keyword", rerank: false, label: "关键词" },
  { mode: "hybrid", rerank: false, label: "混合" },
  { mode: "hybrid", rerank: true, label: "混合加重排" },
];

const answerable = questions.filter((item) => !item.reject);
const rejections = questions.filter((item) => item.reject);

const scoreText = (value) =>
  value == null || Number.isNaN(Number(value))
    ? "无"
    : Number(value).toFixed(4);

const runMode = async (mode, { rerank, minScore } = {}) => {
  const hitCounts = Object.fromEntries(KS.map((k) => [k, 0]));
  const missed = [];
  const correctScores = [];
  const rejectRows = [];

  for (const item of questions) {
    const result = await retrieve({
      query: item.question,
      userId: ownerId,
      topK: LIMIT,
      mode,
      rerank,
      minScore,
      stockCode: item.stockCode || undefined,
    });
    const pool = result.ranked || result.hits;
    if (item.reject) {
      const top = pool[0];
      rejectRows.push({
        question: item.question,
        topScore: top ? top.rerankScore : null,
        kept: result.hits.length,
      });
      continue;
    }
    const index = result.hits.findIndex((hit) =>
      containsFact(hit.content, item.mustContain)
    );
    const rank = index === -1 ? null : index + 1;
    KS.forEach((k) => {
      if (rank && rank <= k) hitCounts[k] += 1;
    });
    if (!rank) missed.push(item.question);
    if (rerank) {
      const match = pool.find((hit) =>
        containsFact(hit.content, item.mustContain)
      );
      correctScores.push(match ? match.rerankScore : null);
      const rrf =
        match && match.rrfRank != null
          ? `融合第 ${match.rrfRank}`
          : "融合未进前 20";
      const rerankRank =
        match && match.rerankRank != null
          ? `重排第 ${match.rerankRank}`
          : "重排未进候选";
      console.log(
        `- ${item.question}: ${rerankRank}，${rrf}，重排分 ${scoreText(match && match.rerankScore)}`
      );
    }
  }

  return { hitCounts, missed, correctScores, rejectRows };
};

const run = async () => {
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    console.error("用法: node scripts/rag-eval.js <user_id> [minScore]");
    process.exit(1);
  }
  let minScore = null;
  if (minScoreArg != null && minScoreArg !== "") {
    minScore = Number(minScoreArg);
    if (!Number.isFinite(minScore)) {
      console.error("阈值需要是数字");
      process.exit(1);
    }
  }

  const total = answerable.length;
  const recallAt1 = {};

  for (const spec of RUNS) {
    console.log(`\n${spec.label}`);
    const { hitCounts, missed, correctScores, rejectRows } = await runMode(
      spec.mode,
      {
        rerank: spec.rerank,
        minScore: spec.rerank ? minScore : null,
      }
    );
    KS.forEach((k) => {
      const recall = (hitCounts[k] / total).toFixed(2);
      console.log(`recall@${k}: ${hitCounts[k]}/${total} = ${recall}`);
    });
    recallAt1[spec.label] = hitCounts[1];
    if (missed.length) {
      console.log("前 5 名未命中:");
      missed.forEach((question) => console.log(`- ${question}`));
    }
    if (spec.rerank) {
      const present = correctScores.filter((score) => score != null);
      const lowest = present.length ? Math.min(...present) : null;
      const rejectScores = rejectRows
        .map((row) => row.topScore)
        .filter((score) => score != null);
      const highestReject = rejectScores.length
        ? Math.max(...rejectScores)
        : null;
      console.log(
        `有答案的正确段里，最低重排分: ${scoreText(lowest)}（${present.length}/${answerable.length} 进了候选）`
      );
      console.log(`无答案的最高重排分: ${scoreText(highestReject)}`);
      rejectRows.forEach((row) => {
        console.log(
          `- 拒答 ${row.question}: 最高分 ${scoreText(row.topScore)}，留下 ${row.kept} 条`
        );
      });
      const emptyRejects = rejectRows.filter((row) => row.kept === 0).length;
      console.log(`拒答结果为空: ${emptyRejects}/${rejections.length}`);
    }
  }

  console.log("\nrecall@1 对照:");
  RUNS.forEach((spec) => {
    console.log(`${spec.label}: ${recallAt1[spec.label]}/${total}`);
  });
};

run().then(() => process.exit(0));
