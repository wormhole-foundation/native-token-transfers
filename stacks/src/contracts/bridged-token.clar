;; Title: bridged-token
;; Version: v1
;; Summary: Simple, non-upgradeable token contract representing an FT bridged from another chain
;;          This is needed because it's not possible to migrate FTs defined with `define-fungible-token` during an update

;; ---------- IMPORTANT!!! ----------
;; When deploying, you may want to rename this file to the actual token name
;; -----------------------------------

(impl-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)
(define-fungible-token bridged-token)

;;;; Constants

(define-constant ERR_UNINITIALIZED (err u14001))
(define-constant ERR_UNAUTHORIZED (err u14002))
(define-constant ERR_ALREADY_INITIALIZED (err u14003))
(define-constant ERR_NOT_OWNER (err u14004))
(define-constant ERR_TRANSFER_INDEX_PREFIX u1000000)

;;;; Data Vars

;; Only the owner of this contract can mint tokens
;; This will be the non-upgradeable `.token-manager` contract and cannot be changed
(define-constant OWNER .token-manager)

;; Runtime deployment config
(define-data-var token-name (optional (string-ascii 32)) none)
(define-data-var token-symbol (optional (string-ascii 32)) none)
(define-data-var token-decimals (optional uint) none)
(define-data-var token-uri (optional (string-utf8 256)) none)

;;;; Public functions: Init

(define-public (initialize
    (name (string-ascii 32))
    (symbol (string-ascii 32))
    (decimals uint)
    (uri (optional (string-utf8 256))))
  (begin
    (try! (check-caller))
    (asserts! (not (is-initialized)) ERR_ALREADY_INITIALIZED)
    (var-set token-name (some name))
    (var-set token-symbol (some symbol))
    (var-set token-decimals (some decimals))
    (var-set token-uri uri)
    (ok true)))

;;;; Public functions: Token manager

(define-public (mint (amount uint) (recipient principal))
  (begin
    (try! (check-caller))
    (ft-mint? bridged-token amount recipient)))

(define-public (burn (amount uint) (sender principal))
  (begin
    (try! (check-caller))
    (ft-burn? bridged-token amount sender)))

;;;; SIP-10 trait implementation

(define-public (transfer
    (amount uint)
    (sender principal)
    (recipient principal)
    (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) ERR_NOT_OWNER)
    (match memo to-print (print to-print) 0x)
    (ft-transfer? bridged-token amount sender recipient)))

(define-read-only (get-name)
  (ok (unwrap! (var-get token-name) ERR_UNINITIALIZED)))

(define-read-only (get-symbol)
  (ok (unwrap! (var-get token-symbol) ERR_UNINITIALIZED)))

(define-read-only (get-decimals)
  (ok (unwrap! (var-get token-decimals) ERR_UNINITIALIZED)))

;; @desc Get token balance for any account
(define-read-only (get-balance (p principal))
  (ok (ft-get-balance bridged-token p)))

;; @desc Get token balance for any account
(define-read-only (get-total-supply)
  (ok (ft-get-supply bridged-token)))

(define-read-only (get-token-uri)
  (begin
    (asserts! (is-initialized) ERR_UNINITIALIZED)
    (ok (var-get token-uri))))

;;;; Public functions: Batch actions

(define-public (transfer-many
    (transfers (list 200 {
      amount: uint,
      sender: principal,
      recipient: principal,
      memo: (optional (buff 34))
    })))
  (fold transfer-many-iter transfers (ok u0)))

(define-private (transfer-many-iter
    (single-transfer {
      amount: uint,
      sender: principal,
      recipient: principal,
      memo: (optional (buff 34))
    })
    (result (response uint uint)))
  (match result
    index 
      (let (
          (amount (get amount single-transfer))
          (sender (get sender single-transfer))
          (recipient (get recipient single-transfer))
          (memo (get memo single-transfer)))
        (unwrap!  (transfer amount sender recipient memo) (err (+ ERR_TRANSFER_INDEX_PREFIX index)))
        (ok (+ index u1)))
    err-index
      (err err-index)))

;;;; Read-only functions

(define-read-only (get-owner)
  OWNER)

(define-read-only (is-initialized)
  (is-some (var-get token-name)))

;;;; Private functions

;; @desc Check that the calling contract is the owner
;;       This must be called in any function that modifies state
(define-private (check-caller)
  (ok (asserts! (is-eq contract-caller OWNER) ERR_UNAUTHORIZED)))

;; @desc For unit tests, can remove on deployment
;; #[allow(unused_private_fn)]
(define-private (mint-unchecked (amount uint) (recipient principal))
  (ft-mint? bridged-token amount recipient))