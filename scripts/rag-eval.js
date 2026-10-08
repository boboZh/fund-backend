const { retrieve } = require("../services/rag/retrieve");

// 同一组题跑向量、关键词、混合。混合的 recall@5 用来和两条单路对照。
// 用法: node scripts/rag-eval.js <user_id>
const ownerId = Number(process.argv[2]);
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
    question: "国产 DRAM 投资逻辑-长鑫科技",
    stockCode: "",
    mustContain: "DRAM 龙头",
  },
  {
    question: "高代际产品体系包含哪些板块",
    stockCode: "",
    mustContain: "LPDDR5/5X",
  },
  {
    question: "2025A营业收入",
    stockCode: "688825",
    mustContain: "617.99",
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

const MODES = [
  ["vector", "向量"],
  ["keyword", "关键词"],
  ["hybrid", "混合"],
];

const runMode = async (mode) => {
  const hits = Object.fromEntries(KS.map((k) => [k, 0]));
  const missed = [];

  for (const item of questions) {
    const result = await retrieve({
      query: item.question,
      userId: ownerId,
      topK: LIMIT,
      mode,
      stockCode: item.stockCode || undefined,
    });
    const index = result.hits.findIndex((hit) => containsFact(hit.content, item.mustContain));
    const rank = index === -1 ? null : index + 1;
    KS.forEach((k) => {
      if (rank && rank <= k) hits[k] += 1;
    });
    if (!rank) missed.push(item.question);
  }

  return { hits, missed };
};

const run = async () => {
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    console.error("用法: node scripts/rag-eval.js <user_id>");
    process.exit(1);
  }

  const total = questions.length;
  const recallAt5 = {};

  for (const [mode, label] of MODES) {
    const { hits, missed } = await runMode(mode);
    console.log(`\n${label}`);
    KS.forEach((k) => {
      const recall = (hits[k] / total).toFixed(2);
      console.log(`recall@${k}: ${hits[k]}/${total} = ${recall}`);
    });
    recallAt5[mode] = hits[5];
    if (missed.length) {
      console.log("前 5 名未命中:");
      missed.forEach((question) => console.log(`- ${question}`));
    }
  }

  console.log("\nrecall@5 对照:");
  MODES.forEach(([mode, label]) => {
    console.log(`${label}: ${recallAt5[mode]}/${total}`);
  });
};

run().then(() => process.exit(0));
