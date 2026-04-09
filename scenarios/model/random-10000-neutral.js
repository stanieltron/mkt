"use strict";

const { runRandom10000TrendModelV4 } = require("./scenario-core");

runRandom10000TrendModelV4({
  regime: "neutral",
  title: "Model V4: Neutral 10000 Trades (Long+Short Offset)",
  priceSeed: "v4-neutral-price",
  tradeSeed: "v4-neutral-trades",
});
