"use strict";

const { runRandom10000TrendModelV2 } = require("./scenario-core");

runRandom10000TrendModelV2({
  regime: "downtrend",
  title: "Model V2: Downtrend 10000 Trades (Target ~0.5x)",
  priceSeed: "v2-downtrend-price",
  tradeSeed: "v2-downtrend-trades",
});
