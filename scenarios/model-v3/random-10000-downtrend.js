"use strict";

const { runRandom10000TrendModelV3 } = require("./scenario-core");

runRandom10000TrendModelV3({
  regime: "downtrend",
  title: "Model V3: Downtrend 10000 Trades (Target ~0.5x)",
  priceSeed: "v3-downtrend-price",
  tradeSeed: "v3-downtrend-trades",
});
