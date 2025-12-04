;; Title: ntt-manager
;; Version: v1
;; Summary: NTT Manager contract for Wormhole Native Token Transfer (NTT) protocol
;; Description:
;;   This contract interacts with the token contract (if native) and one or more transceivers.
;;   It is not dependent on any specific cross-chain protocol (Wormhole, Axelar, etc.)

;;;; Traits

;; (impl-trait .ntt-manager-xfer-trait-v1.transfer-trait)
;; (impl-trait .ntt-manager-trait-v1.ntt-manager-trait)

;; Transfer trait used previous contract that we are importing from
;; May not match the version of `transfer-trait` this contract implements
(use-trait previous-transfer-trait .ntt-manager-xfer-trait-v1.transfer-trait)
(use-trait transceiver-trait .transceiver-trait-v1.transceiver-trait)
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;;;; Token Definitions

;;;; Constants

;; Start error codes at 5000 because wormhole-core uses 1000-3000 range

;; Admin function called by non-admin account
(define-constant ERR_UNAUTHORIZED (err u5001))
;; Tried to use an unauthorized transceiver
(define-constant ERR_TRANSCEIVER_UNAUTHORIZED (err u5002))
;; Contract has not been initialized
(define-constant ERR_UNINITIALIZED (err u5005))
;; Contract has not been initialized
(define-constant ERR_ALREADY_INITIALIZED (err u5006))
;; Token contract not registered
(define-constant ERR_ADDR32_NOT_REGISTERED (err u5007))
;; Generic integer overflow
(define-constant ERR_INT_OVERFLOW (err u5008))
;; No known NTT manager on peer chain
(define-constant ERR_UNKNOWN_CHAIN (err u5009))
;; Contract is paused, all actions disabled
(define-constant ERR_PAUSED (err u5010))
;; Integer division resulted in remainder
(define-constant ERR_DIV_REMAINDER (err u5011))
;; Peer not found for protocol
(define-constant ERR_NO_PEER (err u5012))

;; Update process errors
(define-constant ERR_UPG_UNAUTHORIZED (err u5101))
(define-constant ERR_UPG_CHECK_CONTRACT_ADDRESS (err u5103))
(define-constant ERR_UPG_TOKEN_BALANCE (err u5104))

;; Token transfer: Building message
(define-constant ERR_TT_GET_DECIMALS (err u5201))
(define-constant ERR_TT_PAYLOAD_LEN (err u5202))
(define-constant ERR_TT_AMOUNT (err u5203))
(define-constant ERR_TT_RECIPIENT_ADDRESS (err u5204))
(define-constant ERR_TT_RECIPIENT_CHAIN (err u5205))
;; Token transfer: Parsing fields
(define-constant ERR_TT_PARSING_PREFIX (err u5210))
(define-constant ERR_TT_PARSING_DECIMALS (err u5211))
(define-constant ERR_TT_PARSING_AMOUNT (err u5212))
(define-constant ERR_TT_PARSING_SOURCE_TOKEN (err u5213))
(define-constant ERR_TT_PARSING_RECIPIENT (err u5214))
(define-constant ERR_TT_PARSING_RECIPIENT_CHAIN (err u5215))
;; Token transfer: Validating fields
(define-constant ERR_TT_CHECK_PREFIX (err u5220))
(define-constant ERR_TT_CHECK_SOURCE_NTT_MANAGER (err u5221))
(define-constant ERR_TT_CHECK_RECIPIENT_CHAIN_ID (err u5223))
(define-constant ERR_TT_CHECK_TOKEN (err u5224))
;; NTT Manager message header: Validating fields
(define-constant ERR_NTT_PARSING_ID (err u5301))
(define-constant ERR_NTT_PARSING_SENDER (err u5302))
(define-constant ERR_NTT_PARSING_PAYLOAD_LEN (err u5303))
(define-constant ERR_NTT_PARSING_PAYLOAD (err u5304))
(define-constant ERR_NTT_PAYLOAD_LEN (err u5305))
(define-constant ERR_NTT_CHECK_OVERLAY (err u5306))
;; NTT payload extension: Parsing/Validating fields
(define-constant ERR_EXT_PARSING_PAYLOAD_LEN (err u5401))
(define-constant ERR_EXT_PARSING_PAYLOAD (err u5402))
(define-constant ERR_EXT_CHECK_PAYLOAD_LEN (err u5403))
(define-constant ERR_EXT_CHECK_OVERLAY (err u5404))
(define-constant ERR_EXT_PARSING_PREFIX (err u5405))
(define-constant ERR_EXT_PARSING_PRINCIPAL_1 (err u5406))
(define-constant ERR_EXT_PARSING_PRINCIPAL_2 (err u5407))

;; Deployment assert errors
(define-constant ERR_SCALING_LIST_LEN (err u5501))
(define-constant ERR_CFG_TOKEN_CONTRACT (err u5503))

(define-constant MAX_VALUE_U8 u255)
(define-constant MAX_VALUE_U16 u65535)
(define-constant MAX_VALUE_U64 u18446744073709551615)

;; ID for a token transfer message: [0x99, 'N', 'T', 'T']
(define-constant PREFIX_TOKEN_TRANSFER 0x994e5454)
;; ID for a Stacks address in payload extension: First four bytes of `keccak256("Stacks Principal")`
(define-constant PREFIX_EXT_STACKS_ADDR 0x3b060a8d)
;; Max length for an NTT manager message
(define-constant NTT_MANAGER_MAX_PAYLOAD_LEN u1024)

;; Stacks chain ID in Wormhole protocol. Copied from `wormhole-core`
(define-constant WORMHOLE_STACKS_CHAIN_ID 0x003c)

;; Known protocols
(define-constant PROTOCOL_WORMHOLE u1)
(define-constant PROTOCOL_AXELAR u2)

;;;; Data Vars: Don't export to sucessor contract
(define-data-var initialized bool false)

;;;; Data Vars: Export to sucessor contract
(define-data-var next-sequence uint u0)

;;;; Data Maps

;; NOTE: These maps do not migrate when the contract is updated
;;       Data structures that grow unbounded and must persist through updates should be kept in`ntt-manager-state`

;; Accounts allowed to call admin functions
;; Defaults to contract deployer
(define-map admins
  principal  ;; Admin account
  bool       ;; Is approved?
)

(map-set admins tx-sender true)

;; Cache locally to avoid `contract-call?`s
(define-map addr32-cache
  principal
  (buff 32)
)

;;;; ----- PAUSE CODE ---->
;; This block can be copied into any contract to add pause functionality (must have error values defined)

(define-data-var pauser principal tx-sender)
(define-data-var paused bool false)

(define-public (pause)
  (begin
    (try! (check-pauser))
    (ok (var-set paused true))))

(define-public (unpause)
  (begin
    (try! (check-pauser))
    (ok (var-set paused false))))

(define-public (transfer-pause-capability (p principal))
  (begin
    (try! (check-pauser))
    (ok (var-set pauser p))))

(define-private (check-pauser)
  (ok (asserts! (or (is-eq contract-caller (get-pauser)) (is-admin contract-caller)) ERR_UNAUTHORIZED)))

(define-read-only (check-paused)
  (ok (asserts! (is-eq (is-paused) false) ERR_PAUSED)))

(define-read-only (is-paused)
  (var-get paused))

(define-read-only (get-pauser)
  (var-get pauser))

;;;; <---- PAUSE_CODE -----

;;;; Public Functions: Admin

;; ALL FUNCTIONS HERE ARE ADMIN FUNCTIONS AND MUST CALL `check-admin`!

;; @desc Add new admin account for this contract
(define-public (add-admin (account principal))
  (begin
    (try! (check-admin))
    (ok (map-set admins account true))))

;; @desc Remove admin account for this contract
(define-public (remove-admin (account principal))
  (begin
    (try! (check-admin))
    (ok (map-delete admins account))))

;;;; Public Functions: Token transfer

;; ALL FUNCTIONS THAT TAKE <transceiver-trait> MUST CALL `check-transceiver`!

;; @desc Lock tokens and send cross-chain message via specified transceiver
;;       `contract-caller` must have registered a 32-byte address via `wormhole-core`
(define-public (send-token-transfer (token <sip-010-trait>) (transceiver <transceiver-trait>) (amount uint) (recipient-chain (buff 2)) (recipient-address (buff 32)))
  (let ((check1 (try! (check-enabled)))
        (check2 (try! (check-transceiver-trait transceiver)))
        (sequence (get-next-sequence))
        (token-decimals (try! (contract-call? token get-decimals)))
        (scaled-val (try! (scale-amount-to-u64 amount token-decimals)))
        (scaled-amount (get amount scaled-val))
        (scaled-decimals-as-buff-1 (try! (uint-to-buff-1-be (get decimals scaled-val))))
        (sender (get addr32 (try! (contract-call? .addr32 register contract-caller))))
        ;; Make unique message ID from block height and sequence
        (message-id (concat
          (uint-to-buff-16-be stacks-block-height)
          (uint-to-buff-16-be sequence)))
        (ntt-peer (unwrap! (contract-call? .ntt-manager-state peers-get recipient-chain) ERR_UNKNOWN_CHAIN))
        (ntt-payload (try! (build-token-transfer-payload message-id scaled-decimals-as-buff-1 sender scaled-amount recipient-address recipient-chain none))))
    (try! (contract-call? .token-manager lock-or-burn-tokens token amount tx-sender))
    (try! (contract-call? transceiver send-token-transfer ntt-payload recipient-chain ntt-peer sender))
    (var-set next-sequence (+ sequence u1))
    (ok sequence)))

;; @desc Lock tokens and send cross-chain message via specified transceiver
;;       Returns a tuple with `recipient: none` if funds still pending because addr32 lookup failed
(define-public (receive-token-transfer (token <sip-010-trait>) (source-chain (buff 2)) (source-ntt-manager (buff 32)) (ntt-manager-payload (buff 1024)))
  (let ((check1 (try! (check-enabled)))
        (transceiver contract-caller)
        (protocol (try! (check-transceiver transceiver)))
        (ntt-manager-message (try! (parse-token-transfer-payload ntt-manager-payload)))
        (peer-decimals (get decimals ntt-manager-message))
        (native-decimals (try! (contract-call? token get-decimals)))
        (amount (try! (scale-decimals (get amount ntt-manager-message) peer-decimals native-decimals)))
        (peer-data (unwrap! (contract-call? .ntt-manager-state peers-get source-chain) ERR_UNKNOWN_CHAIN))
        (uid (keccak256 (concat source-chain ntt-manager-payload)))
        (recipient-addr32 (get recipient-addr32 ntt-manager-message))
        (recipient-from-msg (match (get additional-payload ntt-manager-message)
          ;; We got additinoal payload, try parsing as Stacks principal
          bytes (match (parse-additional-payload-as-stacks-principal bytes)
            o (some o)
            e none)
          ;; No additional payload
          none))
        (recipient (match recipient-from-msg
          ;; QUESTION FOR AR: Which of the following to do here:
          ;;  - Ignore `recipient-addr32` (what is done now)
          ;;  - Do lookup anyways and check against result?
          ;;  - Force fixed value of `recipient-addr32` with payload extension, like `keccak256("PayloadExtension")`
          r r
          ;; If no Stacks principal sent in payload extension, try lookup
          (unwrap! (contract-call? .addr32 lookup recipient-addr32) ERR_ADDR32_NOT_REGISTERED))))

    ;; Check message values
    (asserts! (is-eq source-ntt-manager peer-data)
      ERR_TT_CHECK_SOURCE_NTT_MANAGER)
    (asserts! (is-eq (get recipient-chain ntt-manager-message) WORMHOLE_STACKS_CHAIN_ID)
      ERR_TT_CHECK_RECIPIENT_CHAIN_ID)

    ;; Check for message replay
    (try! (contract-call? .ntt-manager-state consume-message uid))
    
    ;; All checks passed, tranfer funds
    (try! (contract-call? .token-manager unlock-or-mint-tokens token amount recipient))

    (ok {
      source-chain: source-chain,
      sender: (get sender ntt-manager-message),
      recipient-addr32: recipient-addr32,
      recipient: recipient,
      amount: amount,
      uid: uid
    })))

;;;; Public Functions: Contract update and init

;; MUST CALL ONE `initialize-` function prior to use! 

(define-public (initialize-locking-mode (token <sip-010-trait>))
  (begin
    (try! (check-admin))
    (try! (check-uninitialized))
    (var-set initialized true)
    (contract-call? .token-manager initialize-locking-mode token)))

(define-public (initialize-burning-mode
    (name (string-ascii 32))
    (symbol (string-ascii 32))
    (decimals uint)
    (uri (optional (string-utf8 256))))
  (begin
    (try! (check-admin))
    (try! (check-uninitialized))
    (var-set initialized true)
    (contract-call? .token-manager initialize-burning-mode name symbol decimals uri)))

;; @desc Call in successor contract, after active contract has called `start-update`, to finalize update
(define-public (initialize-from-previous
    (previous-contract <previous-transfer-trait>)
    (import {
      pauser: bool
    }))
  (let ((active-contract (contract-call? .ntt-manager-state get-owner)))
    (try! (check-admin))
    (try! (check-uninitialized))
    (asserts! (is-eq (contract-of previous-contract) active-contract) ERR_UPG_UNAUTHORIZED)
    (try! (contract-call? .token-manager finalize-ownership-transfer))
    (try! (contract-call? .ntt-manager-state finalize-ownership-transfer))
    (let ((previous-state (try! (contract-call? previous-contract transfer-state))))
      (var-set next-sequence (get next-sequence previous-state))
      (if (get pauser import)
        (var-set pauser (get pauser previous-state))
        true)
      (var-set initialized true)
      (ok true))))

;; @desc Call in active contract to start update process
(define-public (begin-state-transfer (successor principal))
  (let ((successor-parts (unwrap! (principal-destruct? successor) ERR_UPG_CHECK_CONTRACT_ADDRESS)))
    (try! (check-admin))
    ;; Check we have a contract principal and not a standard principal
    (asserts! (is-some (get name successor-parts)) ERR_UPG_CHECK_CONTRACT_ADDRESS)
    (try! (contract-call? .token-manager start-ownership-transfer successor))
    (try! (contract-call? .ntt-manager-state start-ownership-transfer successor))
    (ok true)))

;; @desc Transfer state and funds to new contract (caller)
;;       Doesn't transfer maps, currently only transfers locked funds
;;       Must call AFTER ownership of state contract has been transferred
;;       Can be called multiple times, in case more funds somehow get locked in old contract
(define-public (transfer-state)
  (let ((active-contract (contract-call? .ntt-manager-state get-owner)))
    ;; Only the contract set by the ContractUpgrade VAA is allowed to call this function
    (asserts! (is-eq contract-caller active-contract) ERR_UNAUTHORIZED)
    ;; Return all moveable state
    (ok {
      next-sequence: (get-next-sequence),
      pauser: (get-pauser)
    })))

;; @desc If update process fails, we can cancel
(define-public (cancel-update)
  (begin
    (try! (check-admin))
    (try! (contract-call? .token-manager cancel-ownership-transfer))
    (contract-call? .ntt-manager-state cancel-ownership-transfer)))

;;;; Read-only Functions

(define-read-only (get-mode)
  (contract-call? .token-manager get-mode))

(define-read-only (is-locking-mode)
  (contract-call? .token-manager is-locking-mode))

(define-read-only (is-burning-mode)
  (contract-call? .token-manager is-burning-mode))

(define-read-only (is-initialized)
  (var-get initialized))

(define-read-only (is-admin (account principal))
  (default-to false (map-get? admins account)))

;; @desc Register transceiver and remove existing transceiver for protocol
(define-public (add-transceiver (transceiver <transceiver-trait>))
  (let ((protocol (try! (contract-call? transceiver get-protocol-id))))
    (try! (check-admin))
    (contract-call? .ntt-manager-state add-transceiver (contract-of transceiver) protocol)))

;; @desc Unregister transceiver
;;       Do not use trrait arg, in case transceiver trait has changed
(define-public (remove-transceiver (p principal))
  (begin
    (try! (check-admin))
    (contract-call? .ntt-manager-state remove-transceiver p)))

;; @desc Add authorized NTT manager on other chain
;; TODO: Add `inbound-limit` for rate limiting?
(define-public (add-peer (chain (buff 2)) (contract (buff 32)))
  (begin
    (try! (check-admin))
    (contract-call? .ntt-manager-state add-peer chain contract )))

;; @desc Remove peer by chain ID
(define-public (remove-peer (chain (buff 2)))
  (begin
    (try! (check-admin))
    (contract-call? .ntt-manager-state peers-delete chain)))

(define-public (get-peer (chain (buff 2)))
  (ok (unwrap! (contract-call? .ntt-manager-state peers-get chain) ERR_NO_PEER)))

(define-read-only (get-token-contract)
  (contract-call? .token-manager get-token-contract))

(define-public (get-token-contract-addr32)
  (get-addr32-from-cache (try! (get-token-contract))))

(define-read-only (get-token-manager)
  (ok .token-manager))

;; @desc Get 32-byte address of token manager
(define-public (get-token-manager-addr32)
  (get-addr32-from-cache .token-manager))

(define-read-only (get-state-contract)
  (ok .ntt-manager-state))

(define-public (get-state-contract-addr32)
  (get-addr32-from-cache .ntt-manager-state))

;; @desc Get latest deployment from state contract
(define-read-only (get-active-contract)
  (ok (contract-call? .ntt-manager-state get-active-ntt-manager)))

;; @desc Get tokens locked in NTT protocol
(define-public (get-tokens-locked (token <sip-010-trait>))
  (get-token-balance token .token-manager))

;; @desc Get token balance for any account
(define-public (get-token-balance (token <sip-010-trait>) (p principal))
  (contract-call? .token-manager get-balance token p))

;; @desc Like previous function but uses trait type
(define-read-only (get-transceiver-trait-protocol (transceiver <transceiver-trait>))
  (contract-call? .ntt-manager-state transceivers-get (contract-of transceiver)))

;; @desc Check principal is a registered transceiver
;;       Returns `(ok protocol)` if so
(define-read-only (check-transceiver (p principal))
  (ok (unwrap! (contract-call? .ntt-manager-state transceivers-get p) ERR_TRANSCEIVER_UNAUTHORIZED)))

;; @desc Like previous function but uses trait type
(define-read-only (check-transceiver-trait (transceiver <transceiver-trait>))
  (check-transceiver (contract-of transceiver)))

(define-read-only (get-next-sequence)
  (var-get next-sequence))

;; @desc Scale amount to different number of decimals
;;       Returns error if funds would be lost due to integer division
(define-read-only (scale-decimals (amount uint) (from uint) (to uint))
  (if (is-eq amount u0)
    (ok u0)
    (if (is-eq to from)
      ;; No adjustment needed
      (ok amount)
      ;; Need to scale amount
      (if (> to from)
        ;; We are increasing decimal precision, multiply amount in message by power of 10
        (ok (* amount (pow u10 (- to from))))
        ;; We are decreasing decimal precision, divide in message by power of 10
        (let ((scaling-factor (pow u10 (- from to)))
              (scaled-amount (/ amount scaling-factor)))
          (asserts! (is-eq (* scaled-amount scaling-factor) amount) ERR_DIV_REMAINDER)
          (ok scaled-amount))))))

;; @desc Scale amount down by `entry` decimals, if needed
;;       This is a single, foldable step for the `scale-amount-to-u64` function
;; NOTE: This will generate a runtime error if `decimals` goes below 0
(define-private (scale-down-by
    (entry uint)
    (acc {
      amount: uint,
      decimals: uint
    }))
  (let ((amount (get amount acc)))
    (if (<= amount MAX_VALUE_U64)
      ;; `amount` fits already
      acc
      ;; Too big, scale amount down by `entry`
      (let ((from (get decimals acc))
            (to (- from entry))
            (scaling-factor (pow u10 (- from to))))
        {
          amount: (/ amount scaling-factor),
          decimals: to
        }))))

;; Represents the max amount of decimals we might have to shift a `u128` to fit in `u64`
(define-constant scaling-list (list u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1 u1))
(asserts! (is-eq (len scaling-list) u19) ERR_SCALING_LIST_LEN)

;; @desc Scale amount and decimals so that amount fits in `u64`
;;       Returns error if funds would be lost due to integer division
(define-read-only (scale-amount-to-u64 (amount uint) (decimals uint))
  (if (is-eq amount u0)
    (ok { amount: u0, decimals: decimals })
    (let ((scaled-val (fold scale-down-by
            scaling-list
            { amount: amount, decimals: decimals }))
        (scaled-amount (get amount scaled-val))
        (scaled-by (- decimals (get decimals scaled-val))))
    ;; Check `amount` fits now
    (asserts! (<= scaled-amount MAX_VALUE_U64) ERR_INT_OVERFLOW)
    ;; Reverse scaling to check for "dust"
    (asserts! (is-eq amount (* scaled-amount (pow u10 scaled-by))) ERR_DIV_REMAINDER)
    (ok scaled-val))))

;;;; Private Functions

;; @desc Check if caller is admin
(define-private (check-admin)
  (ok (asserts! (is-admin contract-caller) ERR_UNAUTHORIZED)))

;; @desc Assert that contract has been initialized
(define-private (check-initialized)
  (ok (asserts! (is-initialized) ERR_UNINITIALIZED)))

;; @desc Assert that contract has NOT been initialized
(define-private (check-uninitialized)
  (ok (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)))

;; @desc Check if we can use contract (initialized, not paused)
(define-private (check-enabled)
  (begin
    (try! (check-initialized))
    (try! (check-paused))
    (ok true)))

;; @desc Get 32-byte address of token contract
;;       Cache results in a data-map since it doesn't change, to avoid the cost of `contract-call?`
(define-private (get-addr32-from-cache (p principal))
  (match (map-get? addr32-cache p)
    ;; Already have, return
    a (ok a)
    ;; Don't have, register
    (let ((addr32 (get addr32 (try! (contract-call? .addr32 register p)))))
      (map-set addr32-cache p addr32)
      (ok addr32))))

;; @desc Build NTT manager payload. This will be later wrapped in a transceiver payload
;;       Max size we allow for NTT manager message is 1024 bytes, so `payload` is capped at 958 bytes
;;
;; Message format:
;;   [32]byte id          // a unique message identifier
;;   [32]byte sender      // original message sender address
;;   uint16   payload_len // length of the payload
;;   []byte   payload
(define-private (build-ntt-manager-payload (id (buff 32)) (sender (buff 32)) (payload (buff 958)))
  (let ((payload-len-as-buff-2 (unwrap! (uint-to-buff-2-be (len payload)) ERR_TT_PAYLOAD_LEN))
        (message (concat
          (concat id sender)
          (concat payload-len-as-buff-2 payload))))
    (asserts! (<= (len message) NTT_MANAGER_MAX_PAYLOAD_LEN) ERR_TT_PAYLOAD_LEN)
    (ok message)))

;; @desc Parse NTT manager payload
(define-private (parse-ntt-manager-payload (ntt-manager-payload (buff 1024)))
  (let ((cursor-id (unwrap! (read-buff-32 { bytes: ntt-manager-payload, pos: u0 })
          ERR_NTT_PARSING_ID))
        (cursor-sender (unwrap! (read-buff-32 (get next cursor-id))
          ERR_NTT_PARSING_SENDER))
        (cursor-payload-len (unwrap! (read-uint-16 (get next cursor-sender))
          ERR_NTT_PARSING_PAYLOAD_LEN))
        (payload-len (get value cursor-payload-len))
        (cursor-payload (unwrap! (read-buff-4096-max (get next cursor-payload-len) (some payload-len))
          ERR_NTT_PARSING_PAYLOAD))
        (payload (unwrap! (as-max-len? (get value cursor-payload) u958)
          ERR_NTT_PAYLOAD_LEN)))

    ;; --- Validate Message ---
    (asserts! (is-eq (get pos (get next cursor-payload)) (len ntt-manager-payload))
      ERR_NTT_CHECK_OVERLAY)

    ;; --- Checks Passed, Return Parsed Payload ---
    (ok {
      id: (get value cursor-id),
      sender: (get value cursor-sender),
      payload: payload
    })))

;; @desc Build NTT manager `NativeTokenTransfer` payload
;;
;; Message format:
;;   [4]byte   prefix = 0x994E5454     // 0x99'N''T''T'
;;   uint8     decimals                // number of decimals for the amount
;;   uint64    amount                  // amount being transferred
;;   [32]byte  source_token            // source chain token address
;;   [32]byte  recipient_address       // the address of the recipient
;;   uint16    recipient_chain         // the Wormhole Chain ID of the recipient
;;   uint16    additional_payload_len  // length of the custom payload (can be 0)
;;   []byte    additional_payload      // custom payload (877 bytes max) - recommended that the first 4 bytes are a unique prefix
(define-private (build-token-transfer-payload (id (buff 32)) (decimals (buff 1)) (sender (buff 32)) (amount uint) (recipient-address (buff 32)) (recipient-chain (buff 2)) (additional-payload (optional (buff 877))))
  (let ((amount-as-buff-8 (unwrap! (uint-to-buff-8-be amount) ERR_TT_AMOUNT))
        (token-addr32 (try! (get-token-contract-addr32)))
        (partial-payload (concat
          (concat PREFIX_TOKEN_TRANSFER decimals)
          (concat
            (concat amount-as-buff-8 token-addr32)
            (concat recipient-address recipient-chain))))
        (payload (match additional-payload
          ;; We have additional payload
          p (let ((len-as-buff-2 (try! (uint-to-buff-2-be (len p)))))
              (concat partial-payload (concat len-as-buff-2 p)))
          ;; No additional payload
          partial-payload)))
    (asserts! (is-eq (len recipient-address) u32) ERR_TT_RECIPIENT_ADDRESS)
    (asserts! (is-eq (len recipient-chain) u2) ERR_TT_RECIPIENT_CHAIN)
    (build-ntt-manager-payload id sender payload)))

;; @desc Parse NTT transceiver payload of a token transfer message
;;
;; TODO: Add support for optional payload extension
(define-private (parse-token-transfer-payload (ntt-manager-payload (buff 1024)))
  (let ((ntt-manager-message (try! (parse-ntt-manager-payload ntt-manager-payload)))
        (payload (get payload ntt-manager-message))
        (cursor-prefix (unwrap! (read-buff-4 { bytes: payload, pos: u0 })
          ERR_TT_PARSING_PREFIX))
        (cursor-decimals (unwrap! (read-uint-8 (get next cursor-prefix))
          ERR_TT_PARSING_DECIMALS))
        (cursor-amount (unwrap! (read-uint-64 (get next cursor-decimals))
          ERR_TT_PARSING_AMOUNT))
        (cursor-source-token (unwrap! (read-buff-32 (get next cursor-amount))
          ERR_TT_PARSING_SOURCE_TOKEN))
        (cursor-recipient-addr32 (unwrap! (read-buff-32 (get next cursor-source-token))
          ERR_TT_PARSING_RECIPIENT))
        (cursor-recipient-chain (unwrap! (read-buff-2 (get next cursor-recipient-addr32))
          ERR_TT_PARSING_RECIPIENT_CHAIN))
        (payload-len (len payload))
        (bytes-read (get pos (get next cursor-recipient-chain)))
        (additional-payload (if (> payload-len bytes-read)
          ;; There's more bytes in the buffer
          (try! (parse-additional-payload (unwrap-panic (slice? payload bytes-read payload-len))))
          ;; There's no additional payload
          none)))

    ;; --- Validate Message ---
    (asserts! (is-eq (get value cursor-prefix) PREFIX_TOKEN_TRANSFER)
      ERR_TT_CHECK_PREFIX)

    ;; --- Checks Passed, Return Parsed Payload ---
    (ok {
      id: (get id ntt-manager-message),
      sender: (get sender ntt-manager-message),
      decimals: (get value cursor-decimals),
      amount: (get value cursor-amount),
      source-token: (get value cursor-source-token),
      recipient-addr32: (get value cursor-recipient-addr32),
      recipient-chain: (get value cursor-recipient-chain),
      additional-payload: additional-payload
    })))

;; @desc Parse NTT transceiver payload extension
;;       This function expects there to be bytes in the buffer, but can return `(ok none)` if payload length is zero
;;
;; Message format:
;;   uint16    additional_payload_len  // length of the custom payload (can be 0)
;;   []byte    additional_payload      // custom payload (877 bytes max) - recommended that the first 4 bytes are a unique prefix
(define-private (parse-additional-payload (payload (buff 1024)))
  (let ((cursor-addl-payload-len (unwrap! (read-uint-16 { bytes: payload, pos: u0 })
          ERR_EXT_PARSING_PAYLOAD_LEN))
        (addl-payload-len (get value cursor-addl-payload-len)))
    (if (> addl-payload-len u0)
      ;; We have additional transceiver payload
      (let ((cursor-addl-payload (unwrap! (read-buff-4096-max (get next cursor-addl-payload-len) (some addl-payload-len))
              ERR_EXT_PARSING_PAYLOAD))
            (bytes (unwrap! (as-max-len? (get value cursor-addl-payload) u877)
              ERR_EXT_CHECK_PAYLOAD_LEN)))
        (asserts! (is-eq (get pos (get next cursor-addl-payload)) (len payload)) ERR_EXT_CHECK_OVERLAY)
        (ok (some bytes)))
      ;; No additional transceiver payload
      (begin
        (asserts! (is-eq (get pos (get next cursor-addl-payload-len)) (len payload)) ERR_EXT_CHECK_OVERLAY)
        (ok none)))))

;; @desc Try to parse NTT transceiver payload extension as a Stacks address
;;       This function expects there to be bytes in the buffer, but can return `(ok none)` if payload length is zero
;;
;; Message format:
;;   []byte    stacks_principal  // Stacks principal encoded as StacksCodec
(define-private (parse-additional-payload-as-stacks-principal (payload (buff 877)))
  (let ((cursor-prefix (unwrap! (read-buff-4 { bytes: payload, pos: u0 })
          ERR_EXT_PARSING_PREFIX))
        (addr-bytes (unwrap! (slice? payload u4 (len payload))
          ERR_EXT_PARSING_PRINCIPAL_1))
        (addr (unwrap! (from-consensus-buff? principal addr-bytes)
          ERR_EXT_PARSING_PRINCIPAL_2)))
    (ok addr)))

;; @desc Get this contract's principal
(define-private (get-contract-principal)
  (as-contract tx-sender))

;;;; `uint` to `buff` conversions

;; @desc Encode `uint` as 1-byte BE buffer. Fails if too big
(define-private (uint-to-buff-1-be (n uint))
  (begin
    (asserts! (<= n MAX_VALUE_U8) ERR_INT_OVERFLOW)
    (ok (unwrap-panic (as-max-len? (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u16 u17)) u1)))))

;; @desc Encode `uint` as 2-byte BE buffer. Fails if too big
(define-private (uint-to-buff-2-be (n uint))
  (begin
    (asserts! (<= n MAX_VALUE_U16) ERR_INT_OVERFLOW)
    (ok (unwrap-panic (as-max-len? (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u15 u17)) u2)))))

;; @desc Encode `uint` as 8-byte BE buffer. Fails if too big
(define-private (uint-to-buff-8-be (n uint))
  (begin
    (asserts! (<= n MAX_VALUE_U64) ERR_INT_OVERFLOW)
    (ok (unwrap-panic (as-max-len? (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u9 u17)) u8)))))

;; @desc Encode `uint` as 16-byte BE buffer. Can't fail
(define-private (uint-to-buff-16-be (n uint))
  (unwrap-panic (as-max-len? (unwrap-panic (slice? (unwrap-panic (to-consensus-buff? n)) u1 u17)) u16)))

;;;; Inlined code from `SP2J933XB2CP2JQ1A4FGN8JA968BBG3NK3EKZ7Q9F.hk-cursor-v2`

;; Inlining code avoids the overhead from `contract-call?`
;; Only include the functions that are used here

(define-private (read-buff-1 (cursor { bytes: (buff 4096), pos: uint }))
  (ok {
    value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) (get pos cursor) (+ (get pos cursor) u1)) (err u1)) u1) (err u1)),
    next: { bytes: (get bytes cursor), pos: (+ (get pos cursor) u1) }
  }))

(define-private (read-buff-2 (cursor { bytes: (buff 4096), pos: uint }))
  (ok {
    value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) (get pos cursor) (+ (get pos cursor) u2)) (err u1)) u2) (err u1)),
    next: { bytes: (get bytes cursor), pos: (+ (get pos cursor) u2) }
  }))

(define-private (read-buff-4 (cursor { bytes: (buff 4096), pos: uint }))
  (ok {
    value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) (get pos cursor) (+ (get pos cursor) u4)) (err u1)) u4) (err u1)),
    next: { bytes: (get bytes cursor), pos: (+ (get pos cursor) u4) }
  }))

(define-private (read-buff-8 (cursor { bytes: (buff 4096), pos: uint }))
  (ok {
    value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) (get pos cursor) (+ (get pos cursor) u8)) (err u1)) u8) (err u1)),
    next: { bytes: (get bytes cursor), pos: (+ (get pos cursor) u8) }
  }))

(define-private (read-buff-32 (cursor { bytes: (buff 4096), pos: uint }))
  (ok {
    value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) (get pos cursor) (+ (get pos cursor) u32)) (err u1)) u32) (err u1)),
    next: { bytes: (get bytes cursor), pos: (+ (get pos cursor) u32) }
  }))

(define-private (read-buff-4096-max (cursor { bytes: (buff 4096), pos: uint }) (size (optional uint)))
  (let ((min (get pos cursor))
        (max (match size value
          (+ value (get pos cursor))
          (len (get bytes cursor)))))
    (ok {
      value: (unwrap! (as-max-len? (unwrap! (slice? (get bytes cursor) min max) (err u1)) u4096) (err u1)),
      next: { bytes: (get bytes cursor), pos: max }
    })))

(define-private (read-uint-8 (cursor { bytes: (buff 4096), pos: uint }))
  (let ((cursor-bytes (try! (read-buff-1 cursor))))
    (ok (merge cursor-bytes { value: (buff-to-uint-be (get value cursor-bytes)) }))))

(define-private (read-uint-16 (cursor { bytes: (buff 4096), pos: uint }))
  (let ((cursor-bytes (try! (read-buff-2 cursor))))
    (ok (merge cursor-bytes { value: (buff-to-uint-be (get value cursor-bytes)) }))))

(define-private (read-uint-64 (cursor { bytes: (buff 4096), pos: uint }))
  (let ((cursor-bytes (try! (read-buff-8 cursor))))
    (ok (merge cursor-bytes { value: (buff-to-uint-be (get value cursor-bytes)) }))))