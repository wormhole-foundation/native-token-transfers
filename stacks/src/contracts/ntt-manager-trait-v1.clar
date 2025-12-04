(use-trait transceiver-trait .transceiver-trait-v1.transceiver-trait)
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; This is needed so that the transceiver can call into the manager
(define-trait ntt-manager-trait (
  ;; Get NTT manager mode:
  ;;  - 0: Locking
  ;;  - 1: Burn/mint
  (get-mode () (response (buff 1) uint))
  ;; Get token balance for given Stacks address
  (get-token-balance (<sip-010-trait> principal) (response uint uint))
  ;; Get tokens locked in NTT protocol (0 if burn mode)
  (get-tokens-locked (<sip-010-trait>) (response uint uint))
  ;; Get Stacks token contract
  (get-token-contract () (response principal uint))
  ;; Get 32-byte address of token contract
  (get-token-contract-addr32 () (response (buff 32) uint))
  ;; Get principal of permanent token manager contract
  (get-token-manager () (response principal uint))
  ;; Get 32-byte address of token manager
  (get-token-manager-addr32 () (response (buff 32) uint))
  ;; Get principal of permanent state contract
  (get-state-contract () (response principal uint))
  ;; Get 32-byte address of state contract
  (get-state-contract-addr32 () (response (buff 32) uint))
  ;; Get latest version of NTT manager from state contract
  (get-active-contract () (response principal uint))
  ;; Get peer for given protocol
  (get-peer ((buff 2)) (response (buff 32) uint))
  ;; Send a token transfer to peer chain
  (send-token-transfer (
      <sip-010-trait>     ;; Token contract
      <transceiver-trait> ;; Transceiver to send message through
      uint                ;; Amount of token to transfer
      (buff 2)            ;; Recipient chain
      (buff 32))          ;; Recipient address
    (response uint uint))
  ;; Process payload for NTT manager
  ;; Transceiver has already parsed and verified VAA and extracted necessary fields
  (receive-token-transfer (
      <sip-010-trait> ;; Token contract
      (buff 2)        ;; Source chain
      (buff 32)       ;; Source NTT manager
      (buff 1024))    ;; NTT manager payload
    (response {
      source-chain: (buff 2),
      sender: (buff 32),
      recipient-addr32: (buff 32),
      recipient: principal,
      amount: uint,
      uid: (buff 32)
    } uint))))