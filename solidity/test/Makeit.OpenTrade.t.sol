pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {Makeit} from "../src/Makeit.sol";

contract MakeitOpenTradeTest is BaseMakeitTest {
    function testOpenLongTradeStoresExpectedValues() public {
        _seedMakeit();

        uint96 margin = 10e6;
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, margin);
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        
        uint256 totalFee = _calculateFee(margin, 10, uint256(makeit.liquidityProvisionFeePpm()) + uint256(makeit.protocolFeePpm()));
        uint256 effectiveMargin = margin - totalFee;
        uint256 expectedTp = trade.entryPriceE18 + (trade.entryPriceE18 * DEFAULT_TP_PPM) / (1_000_000 * 10);
        uint256 expectedSl = trade.entryPriceE18 - (trade.entryPriceE18 / 10);

        assertEq(tradeId, 1);
        assertEq(trade.trader, trader);
        assertEq(uint256(trade.side), uint256(Makeit.Side.LONG));
        assertEq(uint256(trade.status), uint256(Makeit.Status.OPEN));
        assertEq(trade.profitTargetPpm, DEFAULT_TP_PPM);
        assertEq(trade.leverage, 10);
        assertEq(trade.marginUSDC, effectiveMargin);
        assertEq(trade.notionalUSDC, effectiveMargin * 10);
        assertEq(trade.entryPriceE18, _expectedPrice());
        assertEq(trade.tpPriceE18, expectedTp);
        assertEq(trade.slPriceE18, expectedSl);
        assertEq(makeit.nextTradeId(), 2);
        assertEq(makeit.openLongNotionalUSDC(), effectiveMargin * 10);
        assertEq(makeit.openShortNotionalUSDC(), 0);
    }

    function testOpenShortTradeRequiresExistingLongNotional() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();
        uint96 margin = 10e6;
        
        uint256 totalFee = _calculateFee(margin, 10, uint256(makeit.liquidityProvisionFeePpm()) + uint256(makeit.protocolFeePpm()));
        uint256 effectiveMargin = uint256(margin) - totalFee;
        uint256 requestedShortNotional = effectiveMargin * 10;

        vm.startPrank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(Makeit.NoLongNotionalToOffsetShort.selector, requestedShortNotional, 0)
        );
        makeit.openShortTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 10, margin);
        vm.stopPrank();
    }

    function testOpenShortTradeOffsetsLongNotional() public {
        _seedMakeit();
        uint256 longTradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        uint256 shortTradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, 10e6);
        Makeit.Trade memory longTrade = makeit.getTrade(longTradeId);
        Makeit.Trade memory shortTrade = makeit.getTrade(shortTradeId);

        assertEq(uint256(shortTrade.side), uint256(Makeit.Side.SHORT));
        assertLt(shortTrade.tpPriceE18, shortTrade.entryPriceE18);
        assertGt(shortTrade.slPriceE18, shortTrade.entryPriceE18);
        assertEq(makeit.openLongNotionalUSDC(), longTrade.notionalUSDC);
        assertEq(makeit.openShortNotionalUSDC(), shortTrade.notionalUSDC);
    }

    function testOpenTradeRevertsWhenFrozen() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();
        makeit.setTradingFrozen(true);

        vm.startPrank(trader);
        vm.expectRevert(Makeit.TradingFrozen.selector);
        makeit.openLongTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 10, 10e6);
        vm.stopPrank();
    }

    function testOpenTradeRevertsOnInvalidTolerance() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();

        vm.startPrank(trader);
        vm.expectRevert(Makeit.InvalidTolerance.selector);
        makeit.openLongTrade(expectedPriceE18, 10_001, DEFAULT_TP_PPM, 10, 10e6);
        vm.stopPrank();
    }

    function testOpenTradeRevertsOnInvalidProfitTarget() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();

        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(Makeit.InvalidProfitTarget.selector, 0, 10));
        makeit.openLongTrade(expectedPriceE18, 100, 0, 10, 10e6);
        vm.stopPrank();
    }

    function testOpenTradeRevertsOnInvalidLeverage() public {
        _seedMakeit();
        uint256 expectedPriceE18 = _expectedPrice();

        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(Makeit.InvalidTradeLeverage.selector, 1, makeit.maxLeverage()));
        makeit.openLongTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 1, 10e6);
        vm.expectRevert(abi.encodeWithSelector(Makeit.InvalidTradeLeverage.selector, 301, makeit.maxLeverage()));
        makeit.openLongTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 301, 10e6);
        vm.stopPrank();
    }

    function testOpenLongTradeRevertsOnInsufficientEthCoverage() public {
        uint256 expectedPriceE18 = _expectedPrice();
        uint96 margin = 10e6;
        uint256 totalFee = _calculateFee(margin, 10, uint256(makeit.liquidityProvisionFeePpm()) + uint256(makeit.protocolFeePpm()));
        uint256 expectedOpenMargin = uint256(margin) - totalFee;
        uint256 expectedOpenNotional = expectedOpenMargin * 10;

        vm.startPrank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(Makeit.InsufficientEthCoverage.selector, expectedOpenNotional, 0)
        );
        makeit.openLongTrade(expectedPriceE18, 100, DEFAULT_TP_PPM, 10, margin);
        vm.stopPrank();
    }
}
