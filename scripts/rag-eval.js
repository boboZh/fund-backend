const { COLLECTION, getClient } = require("../services/rag/qdrant");
const { embedQuery } = require("../services/rag/embed");
const store = require("../services/rag/store");

// 向量检索的基线。同一组题以后每加一路检索都再跑一遍，看正确片段进没进前 k 名。
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

const rankOf = (points, byId, mustContain) => {
  const index = points.findIndex((point) => {
    const row = byId.get(Number(point.id));
    return row && containsFact(row.content, mustContain);
  });
  return index === -1 ? null : index + 1;
};

const run = async () => {
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    console.error("用法: node scripts/rag-eval.js <user_id>");
    process.exit(1);
  }

  const hits = Object.fromEntries(KS.map((k) => [k, 0]));
  const missed = [];

  for (const item of questions) {
    const must = [{ key: "user_id", match: { value: ownerId } }];
    if (item.stockCode) {
      must.push({ key: "stock_code", match: { value: item.stockCode } });
    }
    const vector = await embedQuery(item.question);
    const result = await getClient().query(COLLECTION, {
      query: vector,
      limit: LIMIT,
      filter: { must },
      with_payload: false,
    });
    const points = Array.isArray(result && result.points) ? result.points : [];
    const rows = await store.listChunksByIds(
      ownerId,
      points.map((point) => point.id)
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const rank = rankOf(points, byId, item.mustContain);

    KS.forEach((k) => {
      if (rank && rank <= k) hits[k] += 1;
    });
    if (!rank) missed.push(item.question);
  }

  const total = questions.length;
  KS.forEach((k) => {
    const recall = (hits[k] / total).toFixed(2);
    console.log(`recall@${k}: ${hits[k]}/${total} = ${recall}`);
  });
  if (missed.length) {
    console.log("前 5 名未命中:");
    missed.forEach((question) => console.log(`- ${question}`));
  }
};

run().then(() => process.exit(0));
