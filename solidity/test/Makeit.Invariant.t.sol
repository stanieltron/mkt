pragma solidity ^0.8.20;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {Makeit} from "../src/Makeit.sol";
import {MockPriceOracle} from "./helpers/MockPriceOracle.sol";

contract MakeitHandler is Test {
    Makeit internal makeit;
    MockPriceOracle internal oracle;
    address internal traderOne;
    address internal traderTwo;
    uint256[] internal tradeIds;

    constructor(Makeit makeit_, MockPriceOracle oracle_, address traderOne_, address traderTwo_) {
        makeit = makeit_;
        oracle = oracle_;
        traderOne = traderOne_;
        traderTwo = traderTwo_;
    }

    function setPrice(uint256 newPriceE18) external {
        oracle.setPriceE18(bound(newPriceE18, 500e18, 10_000e18));
    }

    function openLong(uint256 actorSeed, uint256 profitSeed, uint256 leverageSeed) external {
        address actor = actorSeed % 2 == 0 ? traderOne : traderTwo;
        uint32 maxLeverage = makeit.maxLeverage();
        if (maxLeverage < 2) return;
        uint32 profitTarget = uint32(bound(profitSeed, 1, 1_500_000));
        uint32 tradeLeverage = uint32(bound(leverageSeed, 2, maxLeverage));
        uint256 expectedPriceE18 = oracle.priceE18();

        vm.prank(actor);
        try makeit.openLongTrade(expectedPriceE18, 100, profitTarget, tradeLeverage, 10e6) returns (uint256 tradeId) {
            tradeIds.push(tradeId);
        } catch {}
    }

    function openShort(uint256 actorSeed, uint256 profitSeed, uint256 leverageSeed) external {
        address actor = actorSeed % 2 == 0 ? traderOne : traderTwo;
        uint32 maxLeverage = makeit.maxLeverage();
        if (maxLeverage < 2) return;
        uint32 profitTarget = uint32(bound(profitSeed, 1, 1_500_000));
        uint32 tradeLeverage = uint32(bound(leverageSeed, 2, maxLeverage));
        uint256 expectedPriceE18 = oracle.priceE18();

        vm.prank(actor);
        try makeit.openShortTrade(expectedPriceE18, 100, profitTarget, tradeLeverage, 10e6) returns (uint256 tradeId) {
            tradeIds.push(tradeId);
        } catch {}
    }

    function close(uint256 seed) external {
        if (tradeIds.length == 0) return;
        uint256 tradeId = tradeIds[seed % tradeIds.length];
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        if (trade.trader == address(0) || uint256(trade.status) != 0) return;

        vm.prank(trade.trader);
        try makeit.close(tradeId) {} catch {}
    }

    function liquidate(uint256 seed) external {
        if (tradeIds.length == 0) return;
        uint256 tradeId = tradeIds[seed % tradeIds.length];
        try makeit.liquidateTrade(tradeId) {} catch {}
    }
}

contract MakeitInvariantTest is StdInvariant, BaseMakeitTest {
    MakeitHandler internal handler;

    function setUp() public override {
        super.setUp();
        _seedAll();
        handler = new MakeitHandler(makeit, oracle, trader, traderTwo);
        targetContract(address(handler));
    }

    function invariantOpenExposureMatchesTrades() public view {
        uint256 summedLongNotional;
        uint256 summedShortNotional;
        uint256 nextTradeId = makeit.nextTradeId();

        for (uint256 tradeId = 1; tradeId < nextTradeId; tradeId++) {
            Makeit.Trade memory trade = makeit.getTrade(tradeId);
            if (trade.trader == address(0) || uint256(trade.status) != 0) continue;

            if (uint256(trade.side) == uint256(Makeit.Side.LONG)) {
                summedLongNotional += trade.notionalUSDC;
            } else {
                summedShortNotional += trade.notionalUSDC;
            }
        }

        assertEq(makeit.openLongNotionalUSDC(), summedLongNotional);
        assertEq(makeit.openShortNotionalUSDC(), summedShortNotional);
    }

    function invariantNextTradeIdStartsAtOne() public view {
        assertGe(makeit.nextTradeId(), 1);
    }
}
