(use-trait transceiver-trait .transceiver-trait-v1.transceiver-trait)

;; This is needed so that the transceiver can call into the manager
(define-trait ntt-manager-trait (
  ;; Get Stacks token contract
  ;; Fails if we are in burn mode and contract is on foriegn chain
  (get-token-contract () (response principal uint))
  ;; Get 32-byte address of token contract
  (get-addr32-token-contract () (response (buff 32) uint))
  ;; Get principal of permanent state contract
  (get-state-contract () (response principal uint))
  ;; Get principal of permanent token owner contract
  (get-token-owner-contract () (response principal uint))
  ;; Get 32-byte address of state contract
  (get-addr32-state-contract () (response (buff 32) uint))
  ;; Get info from token contract
  (get-token-decimals () (response uint uint))
  (get-token-balance (principal) (response uint uint))
  (get-token-supply () (response uint uint))
  ;; Get latest version of NTT manager from state contract
  (get-active-contract () (response principal uint))
  ;; Get NTT manager mode:
  ;;  - 0: Locking
  ;;  - 1: Burn/mint
  (get-mode () (response (buff 1) uint))
  ;; Send a token transfer to peer chain
  (send-token-transfer (
      <transceiver-trait> ;; Transceiver to send message through
      uint                ;; Amount of token to transfer
      (buff 2)            ;; Recipient chain
      (buff 32))          ;; Recipient address
    (response uint uint))
  ;; Process payload for NTT manager
  ;; Transceiver has already parsed and verified VAA and extracted necessary fields
  (receive-token-transfer (
      (buff 2)      ;; Source chain
      (buff 32)     ;; Source NTT manager
      (buff 1024))  ;; NTT manager payload
    (response {
      source-chain: (buff 2),
      sender: (buff 32),
      recipient-addr32: (buff 32),
      recipient: (optional principal),
      amount: uint,
      uid: (buff 32)
    } uint))
  ;; Release tokens sent to unknown Stacks address
  (release-tokens-pending (
      <transceiver-trait> ;; Transceiver to send message through
      principal)          ;; Stacks address which might have pending tokens
    (response uint uint))))