const yargs = require('yargs/yargs')
const { hideBin } = require('yargs/helpers')
const Web3 = require('web3')

const ERC20Topics = {
    APPROVAL: Web3.utils.sha3('Approval(address,address,uint256)'),
    TRANSFER: Web3.utils.sha3('Transfer(address,address,uint256)')
}

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

/**
 * Gets approvals and correponding allowances for an address.
 * 
 * @param {*} w3 A Web3 instance
 * @param {*} address The address to get approvals for
 * @returns A list of approvals, in the form 
 *              {owner, approvals: [{contract, spender, amount, allowance, allowanceError}, ...]}
 */
const getApprovals = async (w3, address) => {
    // freeze block number to current block for consistent results throughout function
    const blockNumber = await w3.eth.getBlockNumber()

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
        // for convenience in serializing later, we keep all amounts as decimal string
        const amount = w3.utils.toBN(txLog.data).toString(10)
        const approvalKey = [contractAddress, spender].join(".")
        approvalMap[approvalKey] = {amount}
    })
    
    // get remaining allowance for each approval
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

    // promise-wrap thanks to https://github.com/ChainSafe/web3.js/issues/3411
    const errors = []
    await new Promise((resolve, reject) => {
        const batch = new w3.BatchRequest()
        const numRequests = validApprovals.length
        let numResults = 0
        validApprovals.forEach(key => {
            // break up the key tuple
            const [contractAddress, spender] = key.split(".")
            const contract = new w3.eth.Contract(allowanceAbi, contractAddress)
            const request = contract.methods.allowance(address, spender).call.request({}, blockNumber, (error, allowance) => {
                numResults += 1
                const approvalKey = [contractAddress, spender].join(".")
                if (error) {
                    console.error('Error while retrieving allowance', {contractAddress, spender, error})
                    approvalMap[approvalKey].allowanceError = true
                }
                else {
                    approvalMap[approvalKey].allowance = allowance
                }
                if (numResults === numRequests) {
                    resolve()
                }
            })
            batch.add(request)
        })
        batch.execute()
    })

    // make approvals map nicer
    const approvals = Object.keys(approvalMap).map((key) => {
        const [contractAddress, spender] = key.split(".")
        const data = approvalMap[key]

        return {contract: contractAddress, spender: spender, ...data}
    })

    return {owner: address, approvals: approvals}
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
        parse()

    const w3 = new Web3(argv.endpoint)
    const result = await getApprovals(w3, argv.address)
    console.log(JSON.stringify(result, null, 1))
}

if (require.main === module) {
    main().then(() => {})
}

module.exports = {getApprovals}