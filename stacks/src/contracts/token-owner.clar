;; Title: peer-token
;; Version: v1
;; Summary: Non-upgradeable ontract which "owns" the tokens used in NTT manager
;;          This is needed because it's not possible to migrate FTs defined with `define-fungible-token` during an update

;; ---------- IMPORTANT!!! ----------
;;
;; IF USING LOCKING MODE:
;; You need to edit the hardcoded Stacks addresses in the `contract-call?`s !!!
;; Can't use SIP-10 trait here because sBTC (and maybe other tokens) don't implement it

;; IF USING BURNING MODE:
;; You should give the token a name other than `peer-token`
;;
;; -----------------------------------

;; This only gets used in burning mode
(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token peer-token)

;;;; Constants

(define-constant ERR_UNINITIALIZED (err u13001))
(define-constant ERR_UNAUTHORIZED (err u13002))
(define-constant ERR_ALREADY_INITIALIZED (err u13003))
(define-constant ERR_XFER_NOT_IN_PROGRESS (err u13004))
(define-constant ERR_CFG_TOKEN_CONTRACT (err u13005))
(define-constant ERR_INVALID_VALUE (err u13006))

(define-constant ERR_GET_NAME (err u131001))
(define-constant ERR_GET_SYMBOL (err u131002))
(define-constant ERR_GET_DECIMALS (err u131003))
(define-constant ERR_GET_URI (err u131004))

;; NTT can operate in either locking/burning mode (only locking supported now)
(define-constant NTT_MODE_LOCKING 0x00)
(define-constant NTT_MODE_BURNING 0x01)

;;;; Data Vars

;; Only the owner of this contract can make changes to its state
;; This defines what the currently active `ntt-manager` contract is
(define-data-var owner principal .ntt-manager-v1)

;; Used to transfer ownership during contract upgrade
(define-data-var transferring-to (optional principal) none)

;; Runtime deployment config
(define-data-var ntt-mode (optional (buff 1)) none)
(define-data-var token-contract (optional principal) none)
(define-data-var token-decimals (optional uint) none)
(define-data-var token-name (optional (string-ascii 32)) none)
(define-data-var token-symbol (optional (string-ascii 32)) none)
(define-data-var token-uri (optional (string-utf8 256)) none)

;;;; Public functions: Init

;; ALL PUBLIC FUNCTIONS WHICH MODIFY STATE MUST CALL `check-caller`
;; MUST CALL ONE `initialize-` function prior to use! 

(define-public (initialize-locking-mode (contract principal))
  (begin
    (try! (check-caller))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    (if is-in-mainnet
      ;; Check that we've replaced hard-coded addresses
      (asserts! (is-eq contract 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token) ERR_INVALID_VALUE)
      ;; Ignore this check in tests
      true)
    (var-set ntt-mode (some NTT_MODE_LOCKING))
    (var-set token-contract (some contract))
    ;; TODO: Check with someone that it's okay to save these (they can't/shouldn't change for a deployed contract)
    (var-set token-name (some (unwrap! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-name) ERR_GET_NAME)))
    (var-set token-symbol (some (unwrap! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-symbol) ERR_GET_SYMBOL)))
    (var-set token-decimals (some (unwrap! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-decimals) ERR_GET_DECIMALS)))
    (var-set token-uri (unwrap! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-token-uri) ERR_GET_URI))
    (ok true)))

(define-public (initialize-burning-mode
    (name (string-ascii 32))
    (symbol (string-ascii 32))
    (decimals uint)
    (uri (optional (string-utf8 256))))
  (begin
    (try! (check-caller))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    (var-set ntt-mode (some NTT_MODE_BURNING))
    (var-set token-contract (some .token-owner))
    (var-set token-name (some name))
    (var-set token-symbol (some symbol))
    (var-set token-decimals (some decimals))
    (var-set token-uri uri)
    (ok true)))

;;;; Public functions: Token Operations

(define-public (lock-or-burn-tokens (amount uint) (sender principal))
  (let ((is-locking (try! (is-locking-mode))))
    (try! (check-caller))
    (if is-locking
      ;; Lock tokens in this contract
      ;; TODO: Add memo?
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount sender (get-contract-principal) none))
      ;; Burn FTs
      (try! (ft-burn? peer-token amount sender)))
    (ok true)))

(define-public (unlock-or-mint-tokens (amount uint) (recipient principal))
  (let ((is-locking (try! (is-locking-mode))))
    (try! (check-caller))
    (if is-locking
      ;; Unlock and send
      ;; TODO: Add memo?
      (try! (as-contract (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount tx-sender recipient none)))
      ;; Mint tokens
      (try! (ft-mint? peer-token amount recipient)))
    (ok true)))

;;;; Public functions: Update process

;; @desc Initialize transfer of state contract to new owner
(define-public (start-ownership-transfer (new-owner principal))
  (begin
    (try! (check-caller))
    (ok (var-set transferring-to (some new-owner)))))

;; @desc Cancel transfer to new owner
(define-public (cancel-ownership-transfer)
  (let ((canceled-transfer (unwrap! (var-get transferring-to) ERR_XFER_NOT_IN_PROGRESS)))
    (try! (check-caller))
    (var-set transferring-to none)
    (ok canceled-transfer)))

;; @desc New contract needs to call this to claim ownership and finalize transfer
;;       This 2-step process makes it impossible to transfer ownership to an invalid address
(define-public (finalize-ownership-transfer)
  (let ((new-owner (unwrap! (var-get transferring-to) ERR_XFER_NOT_IN_PROGRESS)))
    (asserts! (is-eq contract-caller new-owner) ERR_UNAUTHORIZED)
    (ok (var-set owner new-owner))))

;;; SIP-10 trait implementation

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34))))
  (let ((is-locking (try! (is-locking-mode))))
    (try! (check-caller))
    (if is-locking
      (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount sender recipient memo)
      (ft-transfer? peer-token amount sender recipient))))

(define-read-only (get-name)
  (ok (unwrap! (var-get token-name) ERR_UNINITIALIZED)))

(define-read-only (get-symbol)
  (ok (unwrap! (var-get token-symbol) ERR_UNINITIALIZED)))

(define-read-only (get-decimals)
  (ok (unwrap! (var-get token-decimals) ERR_UNINITIALIZED)))

;; @desc Get token balance for any account
(define-read-only (get-balance (p principal))
  (if (try! (is-locking-mode))
    (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance p)
    (ok (ft-get-balance peer-token p))))

;; @desc Get token balance for any account
(define-read-only (get-total-supply)
  (if (try! (is-locking-mode))
    (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-total-supply)
    (ok (ft-get-supply peer-token))))

(define-read-only (get-token-uri)
  (begin
    (try! (get-mode))
    (ok (var-get token-uri))))

;;;; Read-only functions

;; @desc Returns contract owner, which is allowed to modify state
(define-read-only (get-owner)
  (var-get owner))

(define-read-only (get-token-contract)
  (ok (unwrap! (var-get token-contract) ERR_UNINITIALIZED)))

;; @desc Get NTT mode: Locking or Burning
;;       Also used to check if contract is initialized
(define-read-only (get-mode)
  (ok (unwrap! (var-get ntt-mode) ERR_UNINITIALIZED)))

(define-read-only (is-initialized)
  (is-ok (get-mode)))

(define-read-only (is-locking-mode)
  (let ((mode (try! (get-mode))))
    (ok (is-eq mode NTT_MODE_LOCKING))))

(define-read-only (is-burning-mode)
  (let ((mode (try! (get-mode))))
    (ok (is-eq mode NTT_MODE_BURNING))))

;;;; Private functions

;; @desc Check that the calling contract is the owner
;;       This must be called in any function that modifies state
(define-private (check-caller)
  (ok (asserts! (is-eq contract-caller (get-owner)) ERR_UNAUTHORIZED)))

;; @desc Get this contract's principal
(define-private (get-contract-principal)
  (as-contract tx-sender))

;; @desc Need this for unit tests
(define-private (mint (amount uint) (recipient principal))
  (ft-mint? peer-token amount recipient))
