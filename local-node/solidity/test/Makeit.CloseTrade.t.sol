pragma solidity ^0.8.20;

import {BaseMakeitTest} from "./BaseMakeitTest.t.sol";
import {Makeit} from "../src/Makeit.sol";

contract MakeitCloseTradeTest is BaseMakeitTest {
    function testTraderCanEarlyCloseLongBeforeLevels() public {
        _seedAll();
        uint96 margin = 10e6;
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, margin);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        uint256 balanceBefore = usdc.balanceOf(trader);

        _setPrice(3_150e18);

        vm.prank(trader);
        makeit.close(tradeId);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        uint256 expectedPayout = uint256(opened.marginUSDC) + ((uint256(opened.notionalUSDC) * (3_150e18 - 3_000e18)) / 3_000e18);

        assertEq(uint256(trade.status), uint256(Makeit.Status.CLOSED_EARLY));
        assertEq(usdc.balanceOf(trader), balanceBefore + expectedPayout);
    }

    function testTraderCanEarlyCloseShortBeforeLevels() public {
        _seedAll();
        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6); // Seed long notional for shorts
        uint96 margin = 10e6;
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, margin);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        uint256 balanceBefore = usdc.balanceOf(traderTwo);

        _setPrice(2_850e18);

        vm.prank(traderTwo);
        makeit.close(tradeId);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        uint256 expectedPayout = uint256(opened.marginUSDC) +
            ((uint256(opened.notionalUSDC) * (3_000e18 - 2_850e18)) / 3_000e18);

        assertEq(uint256(trade.status), uint256(Makeit.Status.CLOSED_EARLY));
        assertEq(usdc.balanceOf(traderTwo), balanceBefore + expectedPayout);
        assertEq(makeit.openShortNotionalUSDC(), 0);
    }

    function testOnlyTraderCanEarlyClose() public {
        _seedAll();
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        _setPrice(3_150e18);

        vm.startPrank(stranger);
        vm.expectRevert(Makeit.NotTrader.selector);
        makeit.close(tradeId);
        vm.stopPrank();
    }

    function testCloseRevertsWithMustUseLiquidationAfterLongTp() public {
        _seedAll();
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        _setPrice(trade.tpPriceE18);

        vm.startPrank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                Makeit.MustUseLiquidation.selector,
                tradeId,
                trade.tpPriceE18,
                trade.tpPriceE18,
                trade.slPriceE18
            )
        );
        makeit.close(tradeId);
        vm.stopPrank();
    }

    function testAnyoneCanLiquidateLongTakeProfit() public {
        _seedAll();
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        _setPrice(opened.tpPriceE18);

        vm.prank(liquidator);
        makeit.liquidateTrade(tradeId);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        assertEq(uint256(trade.status), uint256(Makeit.Status.CLOSED_TP));
    }

    function testAnyoneCanLiquidateShortTakeProfit() public {
        _seedAll();
        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6);
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, 10e6);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        _setPrice(opened.tpPriceE18);

        vm.prank(liquidator);
        makeit.liquidateTrade(tradeId);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        assertEq(uint256(trade.status), uint256(Makeit.Status.CLOSED_TP));
        assertEq(makeit.openShortNotionalUSDC(), 0);
    }

    function testAnyoneCanLiquidateShortStopLoss() public {
        _seedAll();
        _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6);
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, 10e6);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        _setPrice(opened.slPriceE18);

        vm.prank(liquidator);
        makeit.liquidateTrade(tradeId);

        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        assertEq(uint256(trade.status), uint256(Makeit.Status.CLOSED_SL));
        assertEq(makeit.openShortNotionalUSDC(), 0);
    }

    function testLiquidateRevertsBeforeLevels() public {
        _seedAll();
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        Makeit.Trade memory trade = makeit.getTrade(tradeId);
        _setPrice(3_050e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                Makeit.NoTpOrSlHit.selector,
                tradeId,
                3_050e18,
                trade.tpPriceE18,
                trade.slPriceE18
            )
        );
        makeit.liquidateTrade(tradeId);
    }

    function testCannotCloseTwice() public {
        _seedAll();
        uint256 tradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        _setPrice(3_150e18);

        vm.prank(trader);
        makeit.close(tradeId);

        vm.startPrank(trader);
        vm.expectRevert(Makeit.TradeNotOpen.selector);
        makeit.close(tradeId);
        vm.stopPrank();
    }

    function testTakeProfitCannotUseOtherOpenTradeReservedMargin() public {
        _fundMakeit(DEFAULT_POOL_WETH, 0);
        _seedAdapter();

        uint256 firstTradeId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 10e6);
        uint256 secondTradeId = _openLongTradeAs(traderTwo, DEFAULT_TP_PPM, 10, 10e6);
        uint256 wethBefore = weth.balanceOf(address(makeit));

        Makeit.Trade memory opened = makeit.getTrade(firstTradeId);
        Makeit.Trade memory second = makeit.getTrade(secondTradeId);
        _setPrice(opened.tpPriceE18);

        vm.prank(liquidator);
        makeit.liquidateTrade(firstTradeId);

        assertEq(makeit.reservedMarginUSDC(), second.marginUSDC);
        assertEq(uint256(makeit.getTrade(secondTradeId).status), uint256(Makeit.Status.OPEN));
        assertLt(weth.balanceOf(address(makeit)), wethBefore);
    }

    function testShortStopLossKeepsMarginAsUsdc() public {
        _fundMakeit(DEFAULT_POOL_WETH, 0);
        _seedAdapter();

        uint256 longId = _openLongTradeAs(trader, DEFAULT_TP_PPM, 10, 20e6);
        uint256 tradeId = _openShortTradeAs(traderTwo, DEFAULT_TP_PPM, 5, 10e6);
        Makeit.Trade memory long = makeit.getTrade(longId);
        Makeit.Trade memory opened = makeit.getTrade(tradeId);
        uint256 wethBefore = weth.balanceOf(address(makeit));
        _setPrice(opened.slPriceE18);

        vm.prank(liquidator);
        makeit.liquidateTrade(tradeId);

        assertEq(uint256(makeit.getTrade(tradeId).status), uint256(Makeit.Status.CLOSED_SL));
        assertEq(weth.balanceOf(address(makeit)), wethBefore);
        assertEq(makeit.reservedMarginUSDC(), long.marginUSDC);
    }
}
