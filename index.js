const axios = require('axios').default
const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const Web3 = require('web3')
const BN = require('bn.js')

const ERC20Topics = {
    APPROVAL: Web3.utils.sha3('Approval(address,address,uint256)'),
    TRANSFER: Web3.utils.sha3('Transfer(address,address,uint256)')
}

// some ERC-20 ABIs
const getDecimalsAbi = [
    {
        "constant": true,
        "inputs": [],
        "name": "decimals",
        "outputs": [
          {
            "name": "",
            "type": "uint8"
          }
        ],
        "payable": false,
        "type": "function",
        "stateMutability": "view",
    }
]
const balanceOfAbi = [
    {
        constant: true, 
        inputs: [{ name: "_owner", type: "address" }], 
        name: "balanceOf", 
        outputs: [{ name: "balance", type: "uint256" }], 
        type: "function", 
        stateMutability: 'view',
    }, 
]
const allowanceAbi = [
    {
        constant: true, 
        inputs: [{ name: "_owner", type: "address" }, { name: "_spender", type: "address" }], 
        name: "allowance", 
        outputs: [{ name: "remaining", type: "uint256" }], 
        type: "function", 
        stateMutability: 'view',
    }, 
]

// see https://unpkg.com/@uniswap/v2-periphery@1.1.0-beta.0/build/IUniswapV2Router02.json
const getAmountsOutAbi = [
    {
    "inputs": [
        {
        "internalType": "uint256",
        "name": "amountIn",
        "type": "uint256"
        },
        {
        "internalType": "address[]",
        "name": "path",
        "type": "address[]"
        }
    ],
    "name": "getAmountsOut",
    "outputs": [
        {
        "internalType": "uint256[]",
        "name": "amounts",
        "type": "uint256[]"
        }
    ],
    "stateMutability": "view",
    "type": "function"
}
]


const compareNumberKeys = (keys) => {
    return (a, b) => {
        for (const key of keys) {
            const result = a[key] - b[key]
            if (result != 0) { return result; }
        }
        return result;
    }
}
const unpadAddress = (address) => {
    if (!/^0x000000000000000000000000/.test(address)) {
        throw new Error('Not an address')
    }
    return '0x' + address.slice(-40)
}

// promise-wrap based on https://github.com/ChainSafe/web3.js/issues/3411
const makeBatchRequestPromise = (w3, items, getRequest, handleItem) => {
    handleItem = handleItem || (() => {})

    return new Promise((resolve, reject) => {
        const batch = new w3.BatchRequest()
        const numRequests = items.length
        let numResponses = 0

        Array.from(items).forEach((item) => {
            const cb = (error, result) => {
                numResponses += 1
                handleItem(item, error, result, resolve, reject)
                if (numResponses === numRequests) {
                    resolve()
                }
            }

            const request = getRequest(item, cb)
            batch.add(request)
        })

        batch.execute()
    })
}

/**
 * Gets approvals and correponding allowances for an address.
 * 
 * @param {*} w3 A Web3 instance
 * @param {*} address The address to get approvals for
 * @returns A list of approvals, in the form 
 *              {owner, approvals: [{contract, spender, amount, allowance, allowanceError}, ...]}
 */
const getApprovals = async (w3, address, {blockNumber}) => {
    // freeze block number to current block for consistent results throughout function
    blockNumber = blockNumber || await w3.eth.getBlockNumber()

    // used for verification
    const addressLower = address.toLowerCase()

    // get all ERC-20 Approval logs for the address
    const filter = {
        fromBlock: 1,
        toBlock: blockNumber,
        topics: [
            ERC20Topics.APPROVAL,
            w3.utils.padLeft(address, 64),
            null
        ]
    }

    // perform the call; sort just in case they don't come in sorted
    const approvalLogs = (await w3.eth.getPastLogs(filter)).sort(
        compareNumberKeys(['blockNumber', 'transactionIndex', 'logIndex'])
    )

    // get only latest approval for each (contract, owner, spender) combination
    // use '.' as glue for storing a key tuple
    const approvalMap = {}
    const nullAddress = w3.utils.padLeft('0x0', 40)
    approvalLogs.forEach((txLog) => {
        const [action, ownerPadded, spenderPadded] = txLog.topics
        if (action !== ERC20Topics.APPROVAL) {
            throw new Error('Unexpected non-Approval topic in query result logs')
        }
        const [owner, spender] = [unpadAddress(ownerPadded), unpadAddress(spenderPadded)]

        if (owner !== addressLower) {
            throw new Error('Obtained an approval which is not from request owner')
        }
        const contractAddress = txLog.address
        // for convenience we keep all amounts as decimal string
        const amount = w3.utils.toBN(txLog.data).toString(10)
        const approvalKey = [contractAddress, spender].join(".")
        approvalMap[approvalKey] = {amount}
    })
    
    // get remaining allowance for each approval


    // filter out null address spenders
    // we could filter out zero amounts; but it'd be nice to verify that the contract
    // is not buggy and in fact has zero allowance
    const validApprovals = Object.keys(approvalMap)
        // .filter(key => approvalMap[key].amount !== "0")
        .filter(key => {
            const [contractAddress, spender] = key.split(".")
            return spender !== nullAddress
        })

    // useful stats for debugging
    // console.debug({
    //     numApprovalLogs: approvalLogs.length,
    //     numApprovals: Object.keys(approvalMap).length,
    //     numValidApprovals: validApprovals.length
    // })

    await makeBatchRequestPromise(w3, validApprovals,
        (key, cb) => {
            const [contractAddress, spender] = key.split(".")
            const contract = new w3.eth.Contract(allowanceAbi, contractAddress)
            return contract.methods.allowance(address, spender).call.request({}, blockNumber, cb)
        },
        (key, error, allowance) => {
            if (error) {
                // const [contractAddress, spender] = key.split(".")
                // console.error('Error while retrieving allowance', {contractAddress, spender, error})
                approvalMap[key].allowanceError = true
                return
            }
            approvalMap[key].allowance = allowance
        }
    )
    

    // make approvals map nicer
    const approvals = Object.keys(approvalMap).map((key) => {
        const [contractAddress, spender] = key.split(".")
        const data = approvalMap[key]

        return {contract: contractAddress, spender: spender, ...data}
    })

    return {owner: address, approvals: approvals}
}

const DEXs = {
    UniswapV2Router02: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
}

const TokenListSources = {
    uniswap: 'https://gateway.ipfs.io/ipns/tokens.uniswap.org'
}
const WellKnownTokens = {
    WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
}

const getTokenList = async (url) => {
    const response = await axios.get(url)
    return response.data
}

const getTokenWeiExchangeRateRequest = (w3, {tokenAddress, blockNumber, decimals}, callback) => {
    blockNumber = blockNumber || 'latest'
    // thanks to https://ethereum.stackexchange.com/questions/94384/get-uniswap-exchange-rate-of-any-token-with-web3
    const contract = new w3.eth.Contract(getAmountsOutAbi, DEXs.UniswapV2Router02)
    return contract.methods.getAmountsOut(
        new BN('10', 10).pow(new BN(decimals.toString(10), 10)),
        [tokenAddress, WellKnownTokens.WETH]
    ).call.request({}, blockNumber, callback)
}
/**
 * 
 * @param {*} w3 
 * @param {*} approvals 
 * @param {*} reputations A map {address: reputation} where reputation is a number from 0 (blacklisted) to Number.POSITIVE_INFINITY (whitelisted)
 * @returns 
 */
const addApprovalRiskScore = async (w3, {owner, approvals}, {blockNumber, reputations, etherscanApiKey}) => {
    reputations = reputations || {}
    blockNumber = blockNumber || await w3.eth.getBlockNumber()

    const tokenAddresses = [...new Set(approvals.map(approval => approval.contract))]
    const decimalsMap = {}
    const exchangeRates = []

    // get actual token amount at risk
    const balances = {}
    await makeBatchRequestPromise(w3, approvals, 
        (approval, cb) => {
            const contract = new w3.eth.Contract(balanceOfAbi, approval.contract)
            return contract.methods.balanceOf(owner).call.request({}, blockNumber, cb)
        },
        (approval, error, balance) => {
            if (error) {
                // contract balance is invalid
                balance = 0
            }
            balances[approval.contract] = balance
        }
    )


    // get decimals so we get the correct precision
    await makeBatchRequestPromise(w3, tokenAddresses, 
        (tokenAddress, cb) => {
            const contract = new w3.eth.Contract(getDecimalsAbi, tokenAddress)
            return contract.methods.decimals().call.request({}, blockNumber, cb)
        },
        (tokenAddress, error, decimals) => {
            if (error) {
                // console.trace('Could not fetch decimals for', {tokenAddress})
                // TODO : find a better solution?
                decimals = '18'
            }
            decimalsMap[tokenAddress] = decimals
        }
    )

    // get the exchange rate from UniSwap
    await makeBatchRequestPromise(w3, tokenAddresses, 
        (tokenAddress, cb) => {
            return getTokenWeiExchangeRateRequest(w3, {
                tokenAddress: tokenAddress,
                blockNumber: blockNumber,
                decimals: decimalsMap[tokenAddress]
            }, cb)
        },
        (tokenAddress, error, rates) => {
            if (error) {
                // not exchangable -> 0 exchange rate
                rates = [1, 0]
            }
            const [amountInToken, amountInWei] = rates
            exchangeRates[tokenAddress] = amountInWei/amountInToken
        }
    )
    const verifiedContracts = new Set([])
    if (etherscanApiKey) {
        // TODO : insert etherscan api contract verification here!
        const https = require('https')
        for (tokenAddress of tokenAddresses) {
            if (tokenAddress in reputation) {
                // already determined reputation, no need for reputation check
                continue
            }
            const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${tokenAddress}&apikey=${etherscanApiKey}`;
            const response = await axios.get(url)
            const isVerified = response.data.status === '1'
            if (isVerified) {
                verifiedContracts.add(tokenAddress)
            }
        }

        https.get(url, (response) => {
            console.log(response);
        });
    }
    // console.error({exchangeRates, decimalsMap, verifiedContracts})
    // TODO : transaction history check per address
    const transactionHistoryReputations = {}

    const getRiskScore = (approval) => {
        const reputation = (address) => (reputations[address] || (1 + (verifiedContracts.has(address)? 1 : 0)))
        const likelihood = (contract, spender) => reputation(contract) * reputation(spender)
        const severity = (token, amount) => exchangeRates[token] * amount
        const amountAtRisk = BN.min(
            new BN( approval.amount, 10 ),
            balances[approval.contract] || new BN(0))
        const risk = severity(approval.contract, amountAtRisk) * likelihood(approval.contract, approval.spender)
        return risk
    }
    return {
        owner: owner, 
        approvals: approvals.map((approval) => 
            ({...approval, risk: getRiskScore(approval), balance: balances[approval.contract]}))
    }
}

const main = async() => {
    // see https://www.npmjs.com/package/yargs
    const argv = yargs(hideBin(process.argv)).
        option(
            'endpoint', {
                default: 'https://mainnet.infura.io/v3/' + process.env['INFURA_PROJECT_ID']
            }
        ).
        option(
            'address', {
                default: '0x224e69025A2f705C8f31EFB6694398f8Fd09ac5C'
            }
        ).
        option(
           'etherscan-api-key', {
               default: process.env['ETHERSCAN_API_KEY']
           }
        ).
        option(
            'calculate-risk', {
                type: Boolean
            }
        ).
        parse()

    const w3 = new Web3(argv.endpoint)
    const blockNumber = await w3.eth.getBlockNumber()
    let result = await getApprovals(w3, argv.address, {blockNumber})
    if (argv.calculateRisk) {
        result =  await addApprovalRiskScore(w3, result, {blockNumber: blockNumber, etherscanApiKey: argv.etherscanApiKey})
    }
    console.log(JSON.stringify(result, null, 1))
}

if (require.main === module) {
    main().then(() => {})
}

module.exports = {getApprovals}