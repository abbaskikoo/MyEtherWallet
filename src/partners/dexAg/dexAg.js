import BigNumber from 'bignumber.js';

import { ERC20, networkSymbols, EthereumTokens } from '../partnersConfig';
import { Toast } from '@/helpers';

import {
  notificationStatuses,
  ChangellyCurrencies,
  statuses,
  TIME_SWAP_VALID,
  PROVIDER_NAME,
  DEX_AG_WALLET_PROXY,
  PROXY_CONTRACT_ADDRESS,
  WETH_TOKEN_ADDRESS,
  SUPPORTED_DEXES, WETH_ABI
} from './config';
import dexAgCalls from './dexAg-calls';

import debug from 'debug';
import { utils } from '@/partners';

const errorLogger = debug('v5:partners-dexag');

const disabled = ['USDT'];

export default class DexAg {
  constructor(props = {}) {
    this.name = DexAg.getName();
    this.baseCurrency = 'ETH';
    this.network = props.network || networkSymbols.ETH;
    this.EthereumTokens = EthereumTokens;
    this.getRateForUnit =
      typeof props.getRateForUnit === 'boolean' ? props.getRateForUnit : false;
    this.hasRates = 0;
    this.currencyDetails = props.currencies || ChangellyCurrencies;
    this.useFixed = true;
    this.tokenDetails = {};
    this.web3 = props.web3;
    this.getSupportedCurrencies(this.network);
  }

  static getName() {
    return PROVIDER_NAME;
  }

  getApiConnector(type) {
    if (type === 'api') {
      return changellyApi;
    }
    return dexAgCalls;
  }

  static isDex() {
    return true;
  }

  async getSupportedCurrencies() {
    try {
      const {
        currencyDetails,
        tokenDetails
      } = await dexAgCalls.getSupportedCurrencies(this.network);
      this.currencyDetails = currencyDetails;
      this.tokenDetails = tokenDetails;
      this.hasRates =
        Object.keys(this.tokenDetails).length > 0 ? this.hasRates + 1 : 0;
    } catch (e) {
      errorLogger(e);
    }
  }

  get ratesRetrieved() {
    return Object.keys(this.tokenDetails).length > 0 && this.hasRates > 0;
  }

  get isValidNetwork() {
    return this.network === networkSymbols.ETH;
  }

  setNetwork(network) {
    this.network = network;
  }

  get currencies() {
    if (this.isValidNetwork) {
      return this.currencyDetails;
    }
    return {};
  }

  validSwap(fromCurrency, toCurrency) {
    if (disabled.includes(fromCurrency) || disabled.includes(toCurrency)) {
      return false;
    }
    if (this.isValidNetwork) {
      return this.currencies[fromCurrency] && this.currencies[toCurrency];
    }
    return false;
  }

  fixedEnabled(currency) {
    return (
      typeof this.currencies[currency].fixRateEnabled === 'boolean' &&
      this.currencies[currency].fixRateEnabled
    );
  }

  calculateRate(inVal, outVal) {
    return new BigNumber(outVal).div(inVal);
  }

  async getRate(fromCurrency, toCurrency, fromValue) {
    return new Promise(async resolve => {
      const vals = await dexAgCalls.getPrice(
        fromCurrency,
        toCurrency,
        fromValue
      );

      resolve(
        vals.map(val => {
          const isKnownToWork = SUPPORTED_DEXES.includes(val.dex);
          return {
            fromCurrency,
            toCurrency,
            provider: val.dex,
            rate: isKnownToWork ? val.price : 0,
            additional: { source: 'dexag' }
          };
        })
      );
    });
  }

  async getRateUpdate(fromCurrency, toCurrency, fromValue, toValue, isFiat) {
    return this.getRate(fromCurrency, toCurrency, fromValue, toValue, isFiat);
  }

  getInitialCurrencyEntries(collectMapFrom, collectMapTo) {
    for (const prop in this.currencies) {
      if (this.currencies[prop])
        collectMapTo.set(prop, {
          symbol: prop,
          name: this.currencies[prop].name
        });
      collectMapFrom.set(prop, {
        symbol: prop,
        name: this.currencies[prop].name
      });
    }
  }

  getUpdatedFromCurrencyEntries(value, collectMap) {
    if (this.currencies[value.symbol]) {
      for (const prop in this.currencies) {
        if (this.currencies[prop])
          collectMap.set(prop, {
            symbol: prop,
            name: this.currencies[prop].name
          });
      }
    }
  }

  getUpdatedToCurrencyEntries(value, collectMap) {
    if (this.currencies[value.symbol]) {
      for (const prop in this.currencies) {
        if (this.currencies[prop])
          collectMap.set(prop, {
            symbol: prop,
            name: this.currencies[prop].name
          });
      }
    }
  }

  async approve(tokenAddress, spender, fromValueWei) {
    try {
      const methodObject = new this.web3.eth.Contract(
        ERC20,
        tokenAddress
      ).methods.approve(spender, fromValueWei);
      return {
        to: tokenAddress,
        value: 0,
        data: methodObject.encodeABI()
      };
    } catch (e) {
      errorLogger(e);
    }
  }

  async prepareApprovals(fromAddress, proxyAddress, fromCurrency, metadata) {
    const contract = new this.web3.eth.Contract(
      [
        {
          constant: true,
          inputs: [],
          name: 'approvalHandler',
          outputs: [
            {
              name: '',
              type: 'address'
            }
          ],
          payable: false,
          stateMutability: 'view',
          type: 'function'
        }
      ],
      PROXY_CONTRACT_ADDRESS
    );
    const providerAddress = await contract.methods.approvalHandler().call();
    const isTokenApprovalNeeded = async (fromToken, fromAddress) => {
      if (fromToken === this.baseCurrency)
        return { approve: false, reset: false };

      const currentAllowance = await new this.web3.eth.Contract(
        ERC20,
        metadata.input.address // this.getTokenAddress(fromToken)
      ).methods
        .allowance(fromAddress, providerAddress)
        .call();

      if (new BigNumber(currentAllowance).gt(new BigNumber(0))) {
        if (
          new BigNumber(currentAllowance)
            .minus(new BigNumber(metadata.input.amount))
            .lt(new BigNumber(0))
        ) {
          return { approve: true, reset: true };
        }
        return { approve: false, reset: false };
      }
      return { approve: true, reset: false };
    };

    const { approve, reset } = await isTokenApprovalNeeded(
      fromCurrency,
      fromAddress
    );
    if (approve && reset) {
      return new Set(
        await Promise.all([
          await this.approve(metadata.input.address, providerAddress, 0),
          await this.approve(
            metadata.input.address,
            providerAddress,
            metadata.input.amount
          )
        ])
      );
    } else if (approve) {
      return new Set([
        await this.approve(
          metadata.input.address,
          providerAddress,
          metadata.input.amount
        )
      ]);
    }
    return new Set();
  }

  getWethContract(trade, swapDetails) {
    const wethTokenAddress = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    return new this.web3.eth.Contract(WETH_TOKEN_ADDRESS, WETH_ABI);
  }
  async getEtherToWrap(trade, swapDetails) {
    const methodObject = new this.web3.eth.Contract(WETH_ABI, WETH_TOKEN_ADDRESS)
      .methods; //.approve(spender, fromValueWei);

    if (!trade.metadata.input) {
      return 0;
    }
    if (trade.metadata.input.address != WETH_TOKEN_ADDRESS) {
      return 0;
    }
    const wethAmount = trade.metadata.input.amount;
    const wethContract = new this.web3.eth.Contract(
      ERC20,
      WETH_TOKEN_ADDRESS
    );
    // const accountAddress = await signer.getAddress();
    const wethBalance = new BigNumber(await wethContract.balanceOf(swapDetails.toAddress).call());
    const balance = new BigNumber(await this.web3.eth.getBalance(swapDetails.toAddress));
    if (wethBalance.gte(wethAmount)) {
      // Enough weth, no need to wrap
      return 0;
    }
    const totalBalance = balance.add(wethBalance);
    if (totalBalance.lt(wethAmount)) {
      // Insufficient balance
      return -1;
    }
    // eth to wrap = weth required for trade - weth balance
    const ethToWrap = wethBalance.sub(wethAmount).mul(-1);
    return ethToWrap.toString();
  }

  async generateDataForTransactions(
    providerAddress,
    swapDetails,
    tradeDetails
  ) {
    try {
      const preparedTradeTxs = await this.prepareApprovals(
        swapDetails.fromAddress,
        providerAddress,
        swapDetails.fromCurrency,
        tradeDetails.metadata
      );

      const tx = {
        to: tradeDetails.trade.to,
        data: tradeDetails.trade.data,
        value: tradeDetails.trade.value
      };
      if (tradeDetails.metadata.gasPrice) {
        tx.gasPrice = tradeDetails.metadata.gasPrice;
      }
      preparedTradeTxs.add(tx);

      const swapTransactions = Array.from(preparedTradeTxs);

      return [...swapTransactions];
    } catch (e) {
      errorLogger(e);
      throw e;
    }
  }

  async startSwap(swapDetails) {
    swapDetails.maybeToken = true;

    const dexToUse = SUPPORTED_DEXES.includes(swapDetails.provider)
      ? swapDetails.provider
      : 'ag';

    const tradeDetails = await this.createTransaction(swapDetails, dexToUse);
    const providerAddress = tradeDetails.metadata.input
      ? tradeDetails.metadata.input.spender
        ? tradeDetails.metadata.input.spender
        : tradeDetails.trade.to
      : tradeDetails.trade.to;

    swapDetails.dataForInitialization = await this.generateDataForTransactions(
      providerAddress,
      { ...swapDetails },
      tradeDetails
    );

    swapDetails.isExitToFiat = false;
    swapDetails.providerReceives = swapDetails.fromValue;
    swapDetails.providerSends = tradeDetails.metadata.query.toAmount;
    swapDetails.providerAddress = providerAddress;

    swapDetails.parsed = {
      sendToAddress: swapDetails.providerAddress,
      status: 'pending',
      validFor: TIME_SWAP_VALID
    };
    swapDetails.isDex = DexAg.isDex();

    return swapDetails;
  }

  async createTransaction(swapDetails, dexToUse) {
    return dexAgCalls.createTransaction({ dex: dexToUse, ...swapDetails });
  }

  static parseOrder(order) {
    return {
      orderId: order.id,
      statusId: order.id,
      sendToAddress: order.payinAddress,
      recValue: order.amountExpectedTo,
      sendValue: order.amountExpectedFrom,
      status: order.status,
      timestamp: order.createdAt,
      validFor: TIME_SWAP_VALID // Rates provided are only an estimate
    };
  }

  static async getOrderStatus(noticeDetails, network) {
    try {
      const status = await dexAgCalls.getStatus(
        noticeDetails.statusId,
        network
      );
      return DexAg.parseChangellyStatus(status);
    } catch (e) {
      Toast.responseHandler(e, false);
    }
  }

  static parseChangellyStatus(status) {
    switch (status) {
      case statuses.new:
        return notificationStatuses.NEW;
      case statuses.waiting:
        return notificationStatuses.SENT;
      case statuses.confirming:
      case statuses.exchanging:
      case statuses.sending:
      case statuses.hold:
        return notificationStatuses.PENDING;
      case statuses.finished:
        return notificationStatuses.COMPLETE;
      case statuses.failed:
        return notificationStatuses.FAILED;
      case statuses.overdue:
      case statuses.refunded:
        return notificationStatuses.CANCELLED;
    }
  }

  async validateAddress(toCurrency, address) {
    return await dexAgCalls.validateAddress(
      {
        currency: toCurrency,
        address: address
      },
      this.network
    );
  }

  getTokenAddress(token) {
    try {
      if (utils.stringEqual(networkSymbols.ETH, token)) {
        return this.EthereumTokens[token].contractAddress;
      }
      return this.web3.utils.toChecksumAddress(
        this.EthereumTokens[token].contractAddress
      );
    } catch (e) {
      errorLogger(e);
      throw Error(`Token [${token}] not included in dex.ag list of tokens`);
    }
  }

  getTokenDecimals(token) {
    try {
      return new BigNumber(this.EthereumTokens[token].decimals).toNumber();
    } catch (e) {
      errorLogger(e);
      throw Error(
        `Token [${token}] not included in dex.ag network list of tokens`
      );
    }
  }

  convertToTokenBase(token, value) {
    const decimals = this.getTokenDecimals(token);
    const denominator = new BigNumber(10).pow(decimals);
    return new BigNumber(value).div(denominator).toString(10);
  }

  convertToTokenWei(token, value) {
    const decimals = this.getTokenDecimals(token);
    const denominator = new BigNumber(10).pow(decimals);
    return new BigNumber(value)
      .times(denominator)
      .integerValue(BigNumber.ROUND_DOWN)
      .toString(10);
  }
}
