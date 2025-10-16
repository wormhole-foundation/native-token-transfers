;; title: wormhole-transceiver-proxy
;; version: v1
;; summary: Checks that `transceiver` trait passed is valid and is active Wormhole Transceiver
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
;; but allows them to avoid updating and re-deploying their contracts every time `wormhole-transceiver` updates
;;
;; =============================
;; Proxy Dataflow
;; =============================
;;
;; -----------------------------
;; 1. Transaction Initiation
;; -----------------------------
;;   When a transaction is initiated, it must include the principal of the current active `wormhole-transceiver` contract as an argument to the function call.
;;   This can be queried from the `wormhole-transceiver-state` by the application and supplied to the user
;;
;; -----------------------------
;; 2. Third-party contract using Wormhole Transceiver
;; -----------------------------
;;   The third-party contract must accept the trait as a function argument and pass it through to this contract.
;;   It is not necessary to check the trait argument here
;;
;; -----------------------------
;; 3. Trait Checker (THIS CONTRACT)
;; -----------------------------
;;   This will take the trait argument and check it against the currently active `wormhole-transceiver` contract in `wormhole-transceiver-state`.
;;   If it matches, it will call the the corresponding function in `wormhole-transceiver`.
;;   If not, an error is returned
;;
;; -----------------------------
;; 4. Wormhole Transceiver Contract
;; -----------------------------
;;   The last step is to call the currently active version of `wormhole-transceiver` implementing `manager-trait`

;;;; Traits

(use-trait transceiver-trait .transceiver-trait-v1.transceiver-trait)

;;;; Constants

;; Trait does not match active contract
(define-constant ERR_CONTRACT_MISMATCH (err u22002))

;;;; Public functions: Proxy for `wormhole-transceiver`

(define-public (get-token-contract (transceiver <transceiver-trait>))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-token-contract)))

(define-public (get-state-contract (transceiver <transceiver-trait>))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-state-contract)))

(define-public (get-ntt-manager (transceiver <transceiver-trait>))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-ntt-manager)))

(define-public (get-ntt-manager-state-contract (transceiver <transceiver-trait>))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-ntt-manager-state-contract)))

(define-public (get-protocol-id (transceiver <transceiver-trait>))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-protocol-id)))

(define-public (get-addr32 (transceiver <transceiver-trait>) (p principal))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver get-addr32 p)))

(define-public (send-token-transfer
    (transceiver <transceiver-trait>)
    (ntt-payload (buff 1024))
    (recipient-chain (buff 2))
    (recipient-ntt-manager (buff 32))
    (refund-address (buff 32)))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver send-token-transfer ntt-payload recipient-chain recipient-ntt-manager refund-address)))

(define-public (parse-and-verify-token-transfer (transceiver <transceiver-trait>) (payload (buff 4096)))
  (begin
    (try! (check-active-transceiver transceiver))
    (contract-call? transceiver parse-and-verify-token-transfer payload)))

;;;; Read-only functions

(define-read-only (check-active-transceiver (expected-contract <transceiver-trait>))
  (let ((active-contract (contract-call? .wormhole-transceiver-state get-active-transceiver)))
    (asserts! (is-eq (contract-of expected-contract) active-contract) ERR_CONTRACT_MISMATCH)
    (ok expected-contract)))