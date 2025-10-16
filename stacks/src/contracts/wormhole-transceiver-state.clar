;; Store the state for `wormhole-transceiver`
;;
;; THIS CONTRACT CANNOT BE UPDATED, so it should contain as little logic as possible
;;
;; This contract is *specifically* meant for state that can grow unbounded, and eventually too big to export
;; State with a finite size is stored im `wormhole-transceiver`, and transfered via import/export functions during an update
;;
;; This contract does not have a version in its name because there cannot be different versions of it
;; If you need additional state in the future, use `kv-store` or deploy a `wormhole-transceiver-state-2` contract

;;;; Constants

;; State contract not initialized (no active core contract set)
(define-constant ERR_UNAUTHORIZED (err u12001))
(define-constant ERR_MESSAGE_REPLAYED (err u12002))
(define-constant ERR_XFER_NOT_IN_PROGRESS (err u12003))
(define-constant ERR_BUFFER_LEN (err u12004))
(define-constant ERR_ALREADY_REGISTERED (err u12004))

;;;; Data Vars

;; Only the owner of this contract can make changes to its state
;; This defines what the currently active `ntt-manager` contract is
(define-data-var owner principal .wormhole-transceiver-v1)

;; Used to transfer ownership during contract upgrade
(define-data-var transferring-to (optional principal) none)

;;;; Data Maps

;; Prevent message replay by tracking messages processed
(define-map consumed-messages
  (buff 32)  ;; Unique ID determined by transceiver
  bool       ;; Consumed?
)

;; Peer transceivers on other chain
(define-map peers
  (buff 2)  ;; Chain ID
  (buff 32) ;; Transceiver contract address
)

;; Since this contract can't be updated, provide a dynamically-typed key/value store,
;; which can be used if additional state is required by future core contract updates.
;;
;; If additional state is necessary, it may be preferable to deploy another state contract instead of using this map,
;; depending on the size, complexity, and the performance needs of the additional state
;;
;; This option is here to provide options and flexibility for future updates
(define-map kv-store (string-ascii 32) (buff 4096))

;;;; Public functions

;; ALL PUBLIC FUNCTIONS WHICH MODIFY STATE MUST CALL `check-caller`

;; @desc Track hashes of processed messages so we don't replay them
;;       Returns `(ok true)` if the message is marked as "consumed"
;;       On failure, returns `(err ...)` does not consume the VAA
;;
;; @param hash: Message hash, computed by `(keccak256 (keccak256 vaa-body))`
(define-public (consume-message (hash (buff 32)))
  (begin
    (try! (check-caller))
    (asserts! (map-insert consumed-messages hash true) ERR_MESSAGE_REPLAYED)
    (ok true)))

;; @desc Add authorized transceiver on other chain
(define-public (add-peer (chain (buff 2)) (contract (buff 32)))
  (begin
    (try! (check-caller))
    (asserts! (is-eq (len chain) u2) ERR_BUFFER_LEN)
    (asserts! (is-eq (len contract) u32) ERR_BUFFER_LEN)
    (asserts! (map-insert peers chain contract) ERR_ALREADY_REGISTERED)
    (ok true)))

(define-public (peers-delete (chain (buff 2)))
  (begin
    (try! (check-caller))
    (ok (map-delete peers chain))))

;; @desc Set raw buffer in key/value store using `map-insert` (fails if entry exists)
;;       Caller is responsible for serializing data with `to-consensus-buff?`
;;       If no error, returns `(ok bool)` with the result of `map-insert`
(define-public (kv-store-insert (key (string-ascii 32)) (value (buff 4096)))
  (begin
    (try! (check-caller))
    (ok (map-insert kv-store key value))))

;; @desc Set raw buffer in key/value store using `map-set` (overwrites existing entries)
;;       Caller is responsible for serializing data with `to-consensus-buff?`
;;       If no error, returns `(ok bool)` with the result of `map-set`
(define-public (kv-store-set (key (string-ascii 32)) (value (buff 4096)))
  (begin
    (try! (check-caller))
    (ok (map-set kv-store key value))))

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

;;;; Read-only functions

;; These functions do not modify state and can be called by anyone

;; @desc Check that the calling contract is the owner
;;       This must be called in any function that modifies state
(define-read-only (check-caller)
  (ok (asserts! (is-eq contract-caller (get-owner)) ERR_UNAUTHORIZED)))

;; @desc Returns contract owner, which is allowed to modify state
(define-read-only (get-owner)
  (var-get owner))

;; @desc Returns currently active Wormhole transceiver
(define-read-only (get-active-transceiver)
  (get-owner))

;; @desc Get contract we're transferring ownership to
(define-read-only (get-transferring-to)
  (var-get transferring-to))

;; These functions simply call `map-get?` on the given map

(define-read-only (kv-store-get (key (string-ascii 32)))
  (map-get? kv-store key))

(define-read-only (consumed-messages-get (hash (buff 32)))
  (map-get? consumed-messages hash))

(define-read-only (peers-get (chain (buff 2)))
  (map-get? peers chain))