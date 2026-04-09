"use strict";

const { runRandom10000TrendModelV1 } = require("./scenario-core");

runRandom10000TrendModelV1({
  regime: "downtrend",
  title: "Model V1: Downtrend 10000 Trades (Target ~0.5x)",
  priceSeed: "v1-downtrend-price",
  tradeSeed: "v1-downtrend-trades",
});

