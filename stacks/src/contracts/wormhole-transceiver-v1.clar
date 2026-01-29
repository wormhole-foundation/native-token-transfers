;; Title: wormhole-transceiver
;; Version: v1
;; Summary: Wormhole Transceiver for Wormhole Native Token Transfer (NTT) protocol
;; Description:
;;   This contract interacts with the NTT manager and the Wormhole Core contract
;;   It does not interact with the token contract, and does not need to be modified when deploying for a new token

;;;; --- INPORTANT NOTE ---
;; This contract does NOT use the wormhole-core proxy!
;; Instead, when the Wormhole contract updates, this contract needs to be updated to use the latest core contract

;;;; Traits

(impl-trait .transceiver-trait-v1.transceiver-trait)
(impl-trait .wormhole-receiver-trait-v1.wormhole-receiver-trait)
(impl-trait .wormhole-transceiver-xfer-trait-v1.transfer-trait)

(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(use-trait protocol-send-trait .protocol-send-trait-v1.send-trait)
(use-trait wormhole-core-trait .wormhole-trait-core-v2.core-trait)
(use-trait ntt-manager-trait .ntt-manager-trait-v1.ntt-manager-trait)
(use-trait previous-transfer-trait .wormhole-transceiver-xfer-trait-v1.transfer-trait)

;;;; Constants

;; Function called by contract that is not NTT manager
(define-constant ERR_UNAUTHORIZED (err u6001))
;; Generic integer overflow
(define-constant ERR_INT_OVERFLOW (err u6002))
;; Contract is paused, all actions disabled
(define-constant ERR_PAUSED (err u6004))
;; Contract has not been initialized
(define-constant ERR_UNINITIALIZED (err u6005))
;; Contract has already been initialized
(define-constant ERR_ALREADY_INITIALIZED (err u6006))
;; Value of SIP-10 trait does not match stored contract
(define-constant ERR_TOKEN_MISMATCH (err u6008))
;; Tried to use invalid NTT manager
(define-constant ERR_MANAGER_MISMATCH (err u6009))
;; Wormhole Core has not been initialized
(define-constant ERR_CORE_UNINITIALIZED (err u6010))
;; Tried to use invalid core contract
(define-constant ERR_CORE_MISMATCH (err u6011))

;; Update process errors
(define-constant ERR_UPG_UNAUTHORIZED (err u6101))
(define-constant ERR_UPG_CHECK_CONTRACT_ADDRESS (err u6103))

;; Errors receiving/parsing/validating TokenTransfer payload
(define-constant ERR_RTT_PARSING_PREFIX (err u6201))
(define-constant ERR_RTT_PARSING_SOURCE_NTT_MANAGER (err u6202))
(define-constant ERR_RTT_PARSING_RECIPIENT_NTT_MANAGER (err u6203))
(define-constant ERR_RTT_PARSING_NTT_PAYLOAD_LEN (err u6204))
(define-constant ERR_RTT_PARSING_NTT_PAYLOAD (err u6205))
(define-constant ERR_RTT_PARSING_XCVR_PAYLOAD_LEN (err u6206))
(define-constant ERR_RTT_PARSING_XCVR_PAYLOAD (err u6207))
(define-constant ERR_RTT_CHECK_PREFIX (err u6210))
(define-constant ERR_RTT_CHECK_NTT_PAYLOAD_LEN (err u6211))
(define-constant ERR_RTT_CHECK_NTT_MANAGER (err u6212))
(define-constant ERR_RTT_CHECK_NTT_MANAGER_ADDR32 (err u6213))
(define-constant ERR_RTT_CHECK_XCVR_PAYLOAD_LEN (err u6214))
(define-constant ERR_RTT_CHECK_PEER_XCVR (err u6215))
(define-constant ERR_RTT_CHECK_OVERLAY (err u6216))

;; Errors sending/building TokenTransfer payload
(define-constant ERR_STT_SOURCE_NTT_LEN (err u6301))
(define-constant ERR_STT_RECIPIENT_NTT_LEN (err u6302))
(define-constant ERR_STT_REFUND_ADDR_LEN (err u6303))
(define-constant ERR_STT_XCVR_PAYLOAD_LEN (err u6304))

;; Errors sending/building TransceiverInit payload
(define-constant ERR_TI_LEN (err u6401))

;; Errors sending/building PeerRegistration payload
(define-constant ERR_PR_LEN (err u6501))

(define-constant PREFIX_TOKEN_TRANSFER 0x9945ff10)
(define-constant PREFIX_TRANSCEIVER_INIT 0x9c23bd3b)
(define-constant PREFIX_PEER_REGISTRATION 0x18fc67c2)

;; ID the NTT manager uses to identify Wormhole
(define-constant NTT_PROTOCOL_WORMHOLE u1)

(define-constant MAX_VALUE_U8 u255)
(define-constant MAX_VALUE_U16 u65535)

(define-constant DEPLOYER tx-sender)
;; NTT manager state contract can't change, but may need to change if deploying from different address
(define-constant NTT_MANAGER_STATE .ntt-manager-state)

;;;; Data Vars
(define-data-var initialized bool false)
(define-data-var ntt-manager principal .ntt-manager-v1)

;;;; Data Maps

;; NOTE: These maps do not migrate when the contract is updated
;;       Data structures that grow unbounded and must persist through updates should be kept in `wormhole-transceiver-state`

;; Accounts allowed to call admin functions
;; Defaults to contract deployer
(define-map admins
  principal  ;; Admin account
  bool       ;; Is approved?
)

(map-set admins DEPLOYER true)

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
    (print {
      topic: "pauser",
      action: "pause",
      caller: contract-caller,
    })
    (ok (var-set paused true))))

(define-public (unpause)
  (begin
    (try! (check-pauser))
    (print {
      topic: "pauser",
      action: "unpause",
      caller: contract-caller,
    })
    (ok (var-set paused false))))

(define-public (transfer-pause-capability (address principal))
  (begin
    (try! (check-pauser))
    (print {
      topic: "pauser",
      action: "transfer-pause-capability",
      caller: contract-caller,
      address: address
    })
    (ok (var-set pauser address))))

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
(define-public (add-admin (address principal))
  (begin
    (try! (check-admin))
    (print {
      topic: "admin",
      action: "add-admin",
      caller: contract-caller,
      address: address,
    })
    (ok (map-set admins address true))))

;; @desc Remove admin account for this contract
(define-public (remove-admin (address principal))
  (let ((admin (try! (check-admin)))
        (deleted (map-delete admins address)))
    (print {
      topic: "admin",
      action: "remove-admin",
      caller: contract-caller,
      address: address,
      result: {
        deleted: deleted
      }
    })
    (ok deleted)))

;; @desc Set new NTT manager
(define-public (set-ntt-manager (manager <ntt-manager-trait>))
  (begin
    (try! (check-admin))
    ;; `print` is in `inner-set-ntt-manager`
    (inner-set-ntt-manager manager)))

;; @desc Add authorized transceiver on other chain
(define-public (add-peer (wormhole-core <wormhole-core-trait>) (chain (buff 2)) (contract (buff 32)))
  (let ((payload (try! (build-peer-registration-payload chain contract))))
    (try! (check-admin))
    (try! (contract-call? .wormhole-transceiver-state add-peer chain contract))
    (try! (contract-call? .wormhole-transceiver-state post-message-via-core-trait wormhole-core payload u0 none))
    (print {
      topic: "admin",
      action: "add-peer",
      caller: contract-caller,
      wormhole-core: wormhole-core,
      peer: {
        chain: chain,
        contract: contract
      }
    })
    (ok true)))

;; @desc Remove peer by chain ID
(define-public (remove-peer (chain (buff 2)))
  (let ((admin (try! (check-admin)))
        (deleted (try! (contract-call? .wormhole-transceiver-state peers-delete chain))))
    (print {
      topic: "admin",
      action: "remove-peer",
      caller: contract-caller,
      peer: {
        chain: chain
      },
      result: {
        deleted: deleted
      }
    })
    (ok deleted)))

;;;; Public Functions: Wormhole-NTT protocol

;; ALL FUNCTIONS HERE ARE CAN ONLY BE CALLED BY NTT MANAGER AND MUST CALL `check-caller` and `check-enabled`!

;; @desc: Post a message to Wormhole Guardians via `wormhole-core` contract
(define-public (send-token-transfer
    (protocol <protocol-send-trait>)
    (ntt-payload (buff 1024))
    (recipient-chain (buff 2))
    (recipient-ntt-manager (buff 32))
    (refund-address (buff 32)))
  (let ((enabled (try! (check-enabled)))
        (checked-caller (try! (check-caller)))
        (ntt-state-addr32 (try! (get-ntt-manager-state-contract-addr32)))
        (payload (try! (build-token-transfer-payload recipient-chain ntt-state-addr32 recipient-ntt-manager refund-address ntt-payload none))))
    (contract-call? .wormhole-transceiver-state post-message-via-send-trait protocol payload u0 none)))

;; @desc Lock tokens and send cross-chain message via specified transceiver
;;       Returns a tuple with `recipient: none` if funds still pending because addr32 lookup failed
(define-public (receive-token-transfer
    (wormhole-core <wormhole-core-trait>)
    (manager <ntt-manager-trait>)
    (token <sip-010-trait>)
    (vaa-bytes (buff 4096)))
  (let ((enabled (try! (check-enabled)))
        (xcvr-message (try! (parse-and-verify-token-transfer wormhole-core vaa-bytes)))
        (ntt-state-addr32 (try! (get-ntt-manager-state-contract-addr32))))

    ;; Check NTT manager passed is our current NTT manager
    (asserts! (is-eq (contract-of manager) (var-get ntt-manager)) ERR_RTT_CHECK_NTT_MANAGER)
    ;; Check message is for this NTT manager
    (asserts! (is-eq (get recipient-ntt-manager xcvr-message) ntt-state-addr32) ERR_RTT_CHECK_NTT_MANAGER_ADDR32)
    ;; Check for message replay
    (try! (contract-call? .wormhole-transceiver-state consume-message (get uid xcvr-message)))

    ;; Checks passed! Send to NTT manager
    (contract-call? manager receive-token-transfer
      token
      (get source-chain xcvr-message)
      (get source-ntt-manager xcvr-message)
      (get ntt-manager-payload xcvr-message))))

;;;; Public Functions: Contract update

;; @desc: Call only on first deployment, when not updating from previous contract
(define-public (initialize
    (manager <ntt-manager-trait>)
    (token <sip-010-trait>)
    (wormhole-core <wormhole-core-trait>))
  (begin
    (try! (check-admin))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    ;; First deployment, must initialize state contract and send init message
    (try! (contract-call? .wormhole-transceiver-state initialize (contract-of token)))
    ;; Update stored contracts
    (try! (inner-set-ntt-manager manager))
    ;; Send TransceiverInit message
    (let ((ntt-state-addr32 (try! (get-ntt-manager-state-contract-addr32)))
          (ntt-mode (try! (contract-call? manager get-mode)))
          (token-addr32 (try! (get-token-contract-addr32)))
          (token-decimals (try! (contract-call? token get-decimals)))
          (token-decimals-as-buff-1 (try! (uint-to-buff-1-be token-decimals)))
          (payload (try! (build-transceiver-init-payload ntt-state-addr32 ntt-mode token-addr32 token-decimals-as-buff-1))))
      (try! (contract-call? .wormhole-transceiver-state post-message-via-core-trait wormhole-core payload u0 none)))
    (ok (var-set initialized true))))

;; @desc: Call only on first deployment, when not updating from previous contract
(define-public (initialize-from-previous
    (manager <ntt-manager-trait>)
    (token <sip-010-trait>)
    (previous-contract <previous-transfer-trait>)
    (import {
      pauser: bool,
    }))
  (begin
    (try! (check-admin))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    ;; This is an upgrade, state contract must be initialized already
    (let ((previous-token (try! (contract-call? .wormhole-transceiver-state get-token-contract))))
      (asserts! (is-eq (contract-of token) previous-token) ERR_TOKEN_MISMATCH)
      (try! (finalize-update token previous-contract import))
      ;; Update stored contracts
      (try! (inner-set-ntt-manager manager))
    (ok (var-set initialized true)))))

;; @desc Call in active contract to start update process
(define-public (start-update (successor principal))
  (let ((successor-parts (unwrap! (principal-destruct? successor) ERR_UPG_CHECK_CONTRACT_ADDRESS)))
    (try! (check-admin))
    ;; Check we have a contract principal and not a standard principal
    (asserts! (is-some (get name successor-parts)) ERR_UPG_CHECK_CONTRACT_ADDRESS)
    (try! (contract-call? .wormhole-transceiver-state start-ownership-transfer successor))
    (print {
      topic: "update",
      action: "start-update",
      caller: contract-caller,
      successor: successor
    })
    (ok true)))

;; @desc Transfer state and funds to new contract (caller)
;;       Doesn't transfer maps, currently only transfers locked funds
;;       Must call AFTER ownership of state contract has been transferred
;;       Can be called multiple times, in case more funds somehow get locked in old contract
(define-public (transfer-state)
  (let ((active-contract (contract-call? .wormhole-transceiver-state get-owner)))
    ;; Only the contract set by the ContractUpgrade VAA is allowed to call this function
    (asserts! (is-eq contract-caller active-contract) ERR_UNAUTHORIZED)
    ;; Return all moveable state
    (ok {
      pauser: (get-pauser),
    })))

;; @desc If update process fails, we can cancel
(define-public (cancel-update)
  (let ((admin (try! (check-admin)))
        (cancelled-transfer (contract-call? .wormhole-transceiver-state cancel-ownership-transfer)))
    (print {
      topic: "update",
      action: "cancel-update",
      caller: contract-caller,
      result: {
        cancelled-transfer: cancelled-transfer
      }
    })
    (ok cancelled-transfer)))

;;;; Public Functions: Misc.

;; @desc Get 32-byte address of ntt-manager state contract
(define-public (get-ntt-manager-state-contract-addr32)
  (get-addr32-from-cache NTT_MANAGER_STATE))

(define-public (get-token-contract-addr32)
  (let ((token (try! (get-token-contract))))
    (get-addr32-from-cache token)))

;;;; Read-only Functions

(define-read-only (is-initialized)
  (var-get initialized))

(define-read-only (is-admin (account principal))
  (default-to false (map-get? admins account)))

(define-read-only (get-protocol-id)
  (ok NTT_PROTOCOL_WORMHOLE))

(define-read-only (get-state-contract)
  (ok .wormhole-transceiver-state))

(define-read-only (get-token-contract)
  (contract-call? .wormhole-transceiver-state get-token-contract ))

(define-read-only (get-ntt-manager)
  (ok (var-get ntt-manager)))

(define-read-only (get-ntt-manager-state-contract)
  (ok NTT_MANAGER_STATE))

;; @desc Get latest deployment from state contract
(define-read-only (get-active-contract)
  (ok (contract-call? .wormhole-transceiver-state get-active-transceiver)))

;; @desc Get protocol contract that is allowed to send messages
(define-read-only (get-protocol-contract)
  (ok (unwrap! (contract-call? .wormhole-core-state get-active-wormhole-core-contract) ERR_CORE_UNINITIALIZED)))

;;;; Private Functions

;; @desc Check if caller is admin
(define-private (check-admin)
  (ok (asserts! (is-admin contract-caller) ERR_UNAUTHORIZED)))

;; @desc Check if caller is ntt-manager
(define-private (check-caller)
  (let ((caller contract-caller))
    (asserts! (is-eq caller (var-get ntt-manager)) ERR_UNAUTHORIZED)
    (ok caller)))

;; @desc Check if contract is active version of Wormhole Core
(define-private (check-wormhole-core (p principal))
  (let ((core (try! (get-protocol-contract))))
    (ok (asserts! (is-eq p core) ERR_CORE_MISMATCH))))

;; @desc Check if contract has been initialized
(define-private (check-initialized)
  (ok (asserts! (is-initialized) ERR_UNINITIALIZED)))

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

;; @desc Set new NTT manager
;;       Private version without admin check
(define-private (inner-set-ntt-manager (manager <ntt-manager-trait>))
  (let ((manager-state-contract (try! (contract-call? manager get-state-contract)))
        (manager-token-contract (try! (contract-call? manager get-token-contract)))
        (xcvr-token-contract (try! (contract-call? .wormhole-transceiver-state get-token-contract))))
    (asserts! (is-eq manager-token-contract xcvr-token-contract) ERR_TOKEN_MISMATCH)
    (asserts! (is-eq manager-state-contract NTT_MANAGER_STATE) ERR_MANAGER_MISMATCH)
    (var-set ntt-manager (contract-of manager))
    (print {
      topic: "admin",
      action: "set-ntt-manager",
      caller: contract-caller,
      manager: manager,
    })
    (ok true)))

;; @desc Call in successor contract, after active contract has called `begin-state-transfer`, to finalize update
(define-private (finalize-update
    (token <sip-010-trait>)
    (previous-contract <previous-transfer-trait>)
    (import {
      pauser: bool,
    }))
  (let ((active-contract (contract-call? .wormhole-transceiver-state get-owner)))
    (asserts! (is-eq (contract-of previous-contract) active-contract) ERR_UPG_UNAUTHORIZED)
    (try! (contract-call? .wormhole-transceiver-state finalize-ownership-transfer))
    (let ((previous-state (try! (contract-call? previous-contract transfer-state))))
      (if (get pauser import)
        (var-set pauser (get pauser previous-state))
        true)
      (print {
        topic: "update",
        action: "finalize-update",
        caller: contract-caller,
        import: import,
        previous-state: previous-state,
        previous-contract: previous-contract,
      })
      (ok true))))

;; @desc Serialize peer registration message to bytes
;;
;; Message format:
;;   [4]byte  prefix = 0x18fc67c2 // bytes4(keccak256("WormholePeerRegistration"))
;;   uint16   peer_chain_id       // Wormhole Chain ID of the foreign peer transceiver
;;   [32]byte peer_address        // the address of the foreign peer transceiver
(define-private (build-peer-registration-payload
    (chain (buff 2))
    (contract (buff 32)))
  (let ((payload (concat PREFIX_PEER_REGISTRATION
          (concat chain contract))))
    (asserts! (is-eq (len payload) u38) ERR_PR_LEN)
    (ok payload)))

;; @desc Serialize transceiver init message to bytes
;;
;; Message format:
;;   [4]byte  prefix = 0x9c23bd3b // bytes4(keccak256("WormholeTransceiverInit"))
;;   [32]byte ntt_manager_address // address of the associated manager
;;   uint8    ntt_manager_mode    // the locking/burning mode of the associated manager
;;   [32]byte token_address       // address of the associated manager's token
;;   uint8    token_decimals      // the number of decimals for that token
(define-private (build-transceiver-init-payload
    (ntt-manager-addr32 (buff 32))
    (ntt-manager-mode (buff 1))
    (token-addr32 (buff 32))
    (token-decimals (buff 1)))
  (let ((payload (concat PREFIX_TRANSCEIVER_INIT
          (concat
            (concat ntt-manager-addr32 ntt-manager-mode)
            (concat token-addr32 token-decimals)))))
    (asserts! (is-eq (len payload) u70) ERR_TI_LEN)
    (ok payload)))

;; @desc Serialize token transfer message to bytes
;;       Max size we allow for NTT transceiver message is 2048 bytes
;;
;; Message format:
;;   [4]byte  prefix
;;   [32]byte source_ntt_manager_address
;;   [32]byte recipient_ntt_manager_address
;;   uint16   ntt_manager_payload_length
;;   []byte   ntt_manager_payload
;;   uint16   transceiver_payload_length (can be 0)
;;   []byte   transceiver_payload
(define-private (build-token-transfer-payload
    (recipient-chain (buff 2)) ;; TODO: Do something with this?
    (source-ntt-manager (buff 32))
    (recipient-ntt-manager (buff 32))
    (refund-address (buff 32)) ;; TODO: Do something with this?
    (ntt-payload (buff 1024))
    (xcvr-payload (optional (buff 1024))))
  (let ((ntt-payload-len-as-buff-2 (try! (uint-to-buff-2-be (len ntt-payload))))
        (partial-payload (concat PREFIX_TOKEN_TRANSFER (concat
          (concat source-ntt-manager recipient-ntt-manager)
          (concat ntt-payload-len-as-buff-2 ntt-payload))))
        (payload (match xcvr-payload
          ;; We have additional payload
          p (let ((len-as-buff-2 (try! (uint-to-buff-2-be (len p)))))
              (concat partial-payload
                (concat len-as-buff-2 p)))
          ;; No additional payload, but we still have to append length of `0x0000`
          (concat partial-payload 0x0000))))
    ;; Addresses must be EXACTLY 32 bytes
    (asserts! (is-eq (len source-ntt-manager) u32) ERR_STT_SOURCE_NTT_LEN)
    (asserts! (is-eq (len recipient-ntt-manager) u32) ERR_STT_RECIPIENT_NTT_LEN)
    (asserts! (is-eq (len refund-address) u32) ERR_STT_REFUND_ADDR_LEN)

    (asserts! (<= (len payload) u2048) ERR_STT_XCVR_PAYLOAD_LEN)
    (ok payload)))

;; @desc Parse and validate Wormhole VAA to unlock tokens
;;       NOTE: Max length for Transceiver payload is 2048 bytes
(define-private (parse-and-verify-token-transfer (wormhole-core <wormhole-core-trait>) (vaa-bytes (buff 4096)))
  (let ((check-core (try! (check-wormhole-core (contract-of wormhole-core))))
        (message (try! (contract-call? wormhole-core parse-and-verify-vaa vaa-bytes)))
        (vaa (get vaa message))
        (source-chain (try! (uint-to-buff-2-be (get emitter-chain vaa))))
        (token-transfer-payload (unwrap! (as-max-len? (get payload vaa) u2048) ERR_RTT_CHECK_XCVR_PAYLOAD_LEN))
        (token-transfer (try! (parse-token-transfer-payload token-transfer-payload)))
        (peer (unwrap! (contract-call? .wormhole-transceiver-state peers-get source-chain) ERR_RTT_CHECK_PEER_XCVR)))

    ;; Check peer transceiver is approved
    (asserts! (is-eq (get emitter-address vaa) peer) ERR_RTT_CHECK_PEER_XCVR)

    (ok (merge token-transfer {
      source-chain: source-chain,
      uid: (get vaa-body-hash message)
    }))))

;; @desc Parse NTT transceiver payload of a token transfer message
;;       NOTE: Max length for NTT payload and NTT payload extension are 1024 bytes each
(define-private (parse-token-transfer-payload (payload (buff 2048)))
  (let ((cursor-prefix (unwrap! (read-buff-4 { bytes: payload, pos: u0 })
          ERR_RTT_PARSING_PREFIX))
        (cursor-source-ntt-manager (unwrap! (read-buff-32 (get next cursor-prefix))
          ERR_RTT_PARSING_SOURCE_NTT_MANAGER))
        (cursor-recipient-ntt-manager (unwrap! (read-buff-32 (get next cursor-source-ntt-manager))
          ERR_RTT_PARSING_RECIPIENT_NTT_MANAGER))
        (cursor-ntt-payload-len (unwrap! (read-uint-16 (get next cursor-recipient-ntt-manager))
          ERR_RTT_PARSING_NTT_PAYLOAD_LEN))
        (ntt-payload-len (get value cursor-ntt-payload-len))
        (cursor-ntt-payload (unwrap! (read-buff-4096-max (get next cursor-ntt-payload-len) (some ntt-payload-len))
          ERR_RTT_PARSING_NTT_PAYLOAD))
        (ntt-manager-payload (unwrap! (as-max-len? (get value cursor-ntt-payload) u1024)
          ERR_RTT_CHECK_NTT_PAYLOAD_LEN))
        (cursor-xcvr-payload-len (unwrap! (read-uint-16 (get next cursor-ntt-payload))
          ERR_RTT_PARSING_XCVR_PAYLOAD_LEN))
        (xcvr-payload-len (get value cursor-xcvr-payload-len))
        (xcvr-payload (if (> xcvr-payload-len u0)
          ;; We have additional transceiver payload
          (let ((cursor-xcvr-payload (unwrap! (read-buff-4096-max (get next cursor-xcvr-payload-len) (some xcvr-payload-len)) ERR_RTT_PARSING_XCVR_PAYLOAD))
                (buff-1024 (unwrap! (as-max-len? (get value cursor-xcvr-payload) u1024) ERR_RTT_CHECK_XCVR_PAYLOAD_LEN)))
            (asserts! (is-eq (get pos (get next cursor-xcvr-payload)) (len payload)) ERR_RTT_CHECK_OVERLAY)
            (some buff-1024))
          ;; No additional transceiver payload
          (begin
            (asserts! (is-eq (get pos (get next cursor-xcvr-payload-len)) (len payload)) ERR_RTT_CHECK_OVERLAY)
            none))))

    ;; --- Validate Message Data ---
    (asserts! (is-eq (get value cursor-prefix) PREFIX_TOKEN_TRANSFER)
      ERR_RTT_CHECK_PREFIX)

    ;; --- Checks Passed, Return Parsed Payload ---
    (ok {
      source-ntt-manager: (get value cursor-source-ntt-manager),
      recipient-ntt-manager: (get value cursor-recipient-ntt-manager),
      ntt-manager-payload: ntt-manager-payload,
      transceiver-payload: xcvr-payload
    })))

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

;;;; Inlined code from `SP2J933XB2CP2JQ1A4FGN8JA968BBG3NK3EKZ7Q9F.hk-cursor-v2`

;; Avoid the overhead from `contract-call?`
;; Only include the functions that are used here

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

(define-private (read-uint-16 (cursor { bytes: (buff 4096), pos: uint }))
  (let ((cursor-bytes (try! (read-buff-2 cursor))))
    (ok (merge cursor-bytes { value: (buff-to-uint-be (get value cursor-bytes)) }))))


