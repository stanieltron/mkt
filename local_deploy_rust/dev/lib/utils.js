const { formatUnits, parseUnits } = require("ethers");

function normalizeAddress(address) {
  return String(address || "").toLowerCase();
}

function isAddressLike(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || ""));
}

function randomReferralCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function usdc6ToDecimal(value) {
  return formatUnits(value, 6);
}

function e18ToDecimal(value) {
  return formatUnits(value, 18);
}

function decimalToE18(value) {
  return parseUnits(String(value), 18);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nowIso() {
  return new Date().toISOString();
}

function toJsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      return v;
    })
  );
}

module.exports = {
  normalizeAddress,
  isAddressLike,
  randomReferralCode,
  usdc6ToDecimal,
  e18ToDecimal,
  decimalToE18,
  clamp,
  nowIso,
  toJsonSafe,
};
