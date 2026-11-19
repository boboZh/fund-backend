const express = require("express");

const router = express.Router();

// Liveness only: dependency readiness is verified separately before cutover.
router.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok" });
});

module.exports = router;
