"use strict";

const { runRandom10000TrendModelV4 } = require("./scenario-core");

runRandom10000TrendModelV4({
  regime: "uptrend",
  title: "Model V4: Uptrend 10000 Trades (Long+Short Offset)",
  priceSeed: "v4-uptrend-price",
  tradeSeed: "v4-uptrend-trades",
});
