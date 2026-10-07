const path = require("path");

const RESEARCH_DIR = path.resolve(__dirname, "../../public/uploads/research");

const pdfPathOf = (fileHash) => path.join(RESEARCH_DIR, `${fileHash}.pdf`);

const droppedPathOf = (fileHash) => path.join(RESEARCH_DIR, `${fileHash}.dropped.json`);

const layoutPathOf = (fileHash) => path.join(RESEARCH_DIR, `${fileHash}.layout.json`);

module.exports = {
  RESEARCH_DIR,
  pdfPathOf,
  droppedPathOf,
  layoutPathOf,
};
