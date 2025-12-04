;; Title: peer-token
;; Version: v1
;; Summary: Non-upgradeable ontract which "owns" the tokens used in NTT manager
;;          This is needed because it's not possible to migrate FTs defined with `define-fungible-token` during an update

;; ---------- IMPORTANT!!! ----------
;;
;; IF USING LOCKING MODE:
;; Do not deploy `bridged-token.clar`
;;
;; IF USING BURNING MODE:
;; You may want to deploy `bridged-token.clar` as the actual token name
;;
;; -----------------------------------

(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;;;; Constants

(define-constant ERR_UNINITIALIZED (err u13001))
(define-constant ERR_UNAUTHORIZED (err u13002))
(define-constant ERR_ALREADY_INITIALIZED (err u13003))
(define-constant ERR_XFER_NOT_IN_PROGRESS (err u13004))
(define-constant ERR_NOT_OWNER (err u13005))

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

;;;; Public functions: Init

;; ALL PUBLIC FUNCTIONS WHICH MODIFY STATE MUST CALL `check-caller`
;; MUST CALL ONE `initialize-` function prior to use! 

(define-public (initialize-locking-mode (token <sip-010-trait>))
  (begin
    (try! (check-caller))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    (var-set ntt-mode (some NTT_MODE_LOCKING))
    (var-set token-contract (some (contract-of token)))
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
    (var-set token-contract (some .bridged-token))
    (try! (contract-call? .bridged-token initialize name symbol decimals uri))
    (ok true)))

;;;; Public functions: Token Operations

(define-public (lock-or-burn-tokens (token <sip-010-trait>) (amount uint) (sender principal))
  (let ((is-locking (try! (is-locking-mode))))
    (try! (check-caller))
    (try! (check-token token))

    (if (is-eq amount u0)
      (ok true)
      (if is-locking
        ;; Lock tokens in this contract
        ;; TODO: Add memo?
        (contract-call? token transfer amount sender (get-contract-principal) none)
        ;; Burn FTs
        (contract-call? .bridged-token burn amount sender)))))

(define-public (unlock-or-mint-tokens (token <sip-010-trait>) (amount uint) (recipient principal))
  (let ((is-locking (try! (is-locking-mode))))
    (try! (check-caller))
    (try! (check-token token))

    (if (is-eq amount u0)
      (ok true)
      (if is-locking
        ;; Unlock and send
        ;; TODO: Add memo?
        (as-contract (contract-call? token transfer amount tx-sender recipient none))
        ;; Mint tokens
        (contract-call? .bridged-token mint amount recipient)))))

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

;;; SIP-10-like interface which checks token trait

(define-public (transfer
    (token <sip-010-trait>)
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34))))
  (begin
    (try! (check-token token))
    (asserts! (is-eq tx-sender sender) ERR_NOT_OWNER)
    (contract-call? token transfer amount sender recipient memo)))

(define-public (get-name (token <sip-010-trait>))
  (begin
    (try! (check-token token))
    (contract-call? token get-name)))

(define-public (get-symbol (token <sip-010-trait>))
  (begin
    (try! (check-token token))
    (contract-call? token get-symbol)))

(define-public (get-decimals (token <sip-010-trait>))
  (begin
    (try! (check-token token))
    (contract-call? token get-decimals)))

;; @desc Get token balance for any account
(define-public (get-balance (token <sip-010-trait>) (p principal))
  (begin
    (try! (check-token token))
    (contract-call? token get-balance p)))

;; @desc Get token balance for any account
(define-public (get-total-supply (token <sip-010-trait>))
  (begin
    (try! (check-token token))
    (contract-call? token get-total-supply)))

(define-public (get-token-uri (token <sip-010-trait>))
  (begin
    (try! (check-token token))
    (contract-call? token get-token-uri)))

;;;; Read-only functions

;; @desc Returns contract owner, which is allowed to modify state
(define-read-only (get-owner)
  (var-get owner))

;; @desc Get NTT mode: Locking or Burning
(define-read-only (get-mode)
  (ok (unwrap! (var-get ntt-mode) ERR_UNINITIALIZED)))

(define-read-only (get-token-contract)
  (ok (unwrap! (var-get token-contract) ERR_UNINITIALIZED)))

(define-read-only (is-initialized)
  (is-some (var-get token-contract)))

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

(define-private (check-token (token <sip-010-trait>))
  (ok (asserts! (is-eq (contract-of token) (try! (get-token-contract))) ERR_UNAUTHORIZED)))

;; @desc Get this contract's principal
(define-private (get-contract-principal)
  (as-contract tx-sender))