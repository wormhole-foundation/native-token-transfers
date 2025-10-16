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

;;;; Constants

;; Trait does not match active contract
(define-constant ERR_CONTRACT_MISMATCH (err u21002))

;;;; Public functions: Proxy for `ntt-manager`

(define-public (get-token-contract (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-contract)))

(define-public (get-state-contract (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-state-contract)))

(define-public (get-decimals (ntt-manager <manager-trait>))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-decimals)))

(define-public (get-token-balance (ntt-manager <manager-trait>) (p principal))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager get-token-balance p)))

(define-public (send-token-transfer (ntt-manager <manager-trait>) (transceiver <transceiver-trait>) (amount uint) (recipient-chain (buff 2)) (recipient-address (buff 32)))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager send-token-transfer transceiver amount recipient-chain recipient-address)))

(define-public (receive-token-transfer (ntt-manager <manager-trait>) (source-chain (buff 2)) (source-ntt-manager (buff 32)) (ntt-manager-payload (buff 1024)))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager receive-token-transfer source-chain source-ntt-manager ntt-manager-payload)))

(define-public (release-tokens-pending (ntt-manager <manager-trait>) (transceiver <transceiver-trait>) (recipient principal))
  (begin
    (try! (check-active-ntt-manager ntt-manager))
    (contract-call? ntt-manager release-tokens-pending transceiver recipient)))

;;;; Read-only functions

(define-read-only (check-active-ntt-manager (expected-contract <manager-trait>))
  (let ((active-contract (contract-call? .ntt-manager-state get-active-ntt-manager)))
    (asserts! (is-eq (contract-of expected-contract) active-contract) ERR_CONTRACT_MISMATCH)
    (ok expected-contract)))