;; title: ntt-manager-proxy
;; version: v1
;; summary: Checks that `manager` trait passed is valid and is active NTT manager
;; description:
;;
;; =============================
;; Proxy Summary
;; =============================
;;
;; We can't do a proper proxy in Clarity, as dynamic dispatch is limited in order to preserve decidability
;; The best we can do is have users of a third-party app query the state contract for the current active contract,
;; and pass it through this contract to validate it.
;;
;; This puts a burden on third-party developers to query the state contract and supply a value to users,
;; but allows them to avoid updating and re-deploying their contracts every time `ntt-manager` updates
;;
;; =============================
;; Proxy Dataflow
;; =============================
;;
;; -----------------------------
;; 1. Transaction Initiation
;; -----------------------------
;;   When a transaction is initiated, it must include the principal of the current active `ntt-manager` contract as an argument to the function call.
;;   This can be queried from the `ntt-manager-state` by the application and supplied to the user
;;
;; -----------------------------
;; 2. Third-party contract using NTT Manager
;; -----------------------------
;;   The third-party contract must accept the trait as a function argument and pass it through to this contract.
;;   It is not necessary to check the trait argument here
;;
;; -----------------------------
;; 3. Trait Checker (THIS CONTRACT)
;; -----------------------------
;;   This will take the trait argument and check it against the currently active `ntt-manager` contract in `ntt-manager-state`.
;;   If it matches, it will call the the corresponding function in `ntt-manager`.
;;   If not, an error is returned
;;
;; -----------------------------
;; 4. NTT Manager Contract
;; -----------------------------
;;   The last step is to call the currently active version of `ntt-manager` implementing `manager-trait`

;;;; Traits

(use-trait manager-trait .ntt-manager-trait-v1.ntt-manager-trait)
(use-trait transceiver-trait .transceiver-trait-v1.transceiver-trait)
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;;;; Constants

;; Trait does not match active contract
(define-constant ERR_CONTRACT_MISMATCH (err u21002))

;;;; Public functions: Proxy for `ntt-manager`

(define-public (get-token-contract (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-contract)))

(define-public (get-token-contract-addr32 (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-contract-addr32)))

(define-public (get-token-manager (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-manager)))

(define-public (get-token-manager-addr32 (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-manager-addr32)))

(define-public (get-state-contract (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-state-contract)))

(define-public (get-state-contract-addr32 (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-state-contract-addr32)))

(define-public (get-active-contract (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-active-contract)))

(define-public (get-mode (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-mode)))

(define-public (send-token-transfer
    (ntt-manager <manager-trait>)
    (token <sip-010-trait>)
    (transceiver <transceiver-trait>)
    (amount uint)
    (recipient-chain (buff 2))
    (recipient-address (buff 32)))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager send-token-transfer token transceiver amount recipient-chain recipient-address)))

(define-public (receive-token-transfer
    (ntt-manager <manager-trait>)
    (token <sip-010-trait>)
    (source-chain (buff 2))
    (source-ntt-manager (buff 32))
    (ntt-manager-payload (buff 1024)))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager receive-token-transfer token source-chain source-ntt-manager ntt-manager-payload)))

;;;; Read-only functions

(define-read-only (check-active-ntt-manager (expected-contract <manager-trait>))
  (let ((active-contract (contract-call? .ntt-manager-state get-active-ntt-manager)))
    (asserts! (is-eq (contract-of expected-contract) active-contract) ERR_CONTRACT_MISMATCH)
    (ok expected-contract)))