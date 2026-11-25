# PleziDo TV Firestore Security Specification (Phase 0)

## Core Data Invariants
1. **Master Gate & Ownership**: Subcollections (`/userProfiles/{userId}/favorites/{favoriteId}`, `/userProfiles/{userId}/talkMessages/{messageId}`) require the parent `/userProfiles/{userId}` document to exist and belong to `request.auth.uid`.
2. **Verified Identity**: All authenticated reads/writes enforce `request.auth != null && request.auth.token.email_verified == true`.
3. **Immutable Ownership & Timestamps**: `uid`, `authorId`, `userId`, and `createdAt` cannot be modified after document creation; `createdAt` and `updatedAt` must equal `request.time`.
4. **Strict Keys & Bounds**: Every document enforces `hasAll` + `hasOnly`, string `.size()` bounds, regex ID validation (`^[a-zA-Z0-9_-]+$`), and enum constraints matching `firebase-blueprint.json`.
5. **Terminal State Protection**: `broadcastRequests` in terminal states (`aired`, `flagged`) cannot be mutated by non-admins, and flagged requests cannot set `isPublicQueue: true`.
6. **Zero Unscoped List Queries**: Every `allow list` rule evaluates `resource.data` directly without `get()`/`exists()` calls.

## The Dirty Dozen Adversarial Payloads
1. **Identity Spoofing on Request**: Creating `/broadcastRequests/req1` with `authorId: "other_uid"` instead of `request.auth.uid`. -> `PERMISSION_DENIED`
2. **Ghost Field Injection (Shadow Update)**: Creating `/userProfiles/{uid}` with extra field `isAdmin: true`. -> `PERMISSION_DENIED`
3. **Unverified Email Bypass**: Attempting write when `email_verified: false` (even with admin email). -> `PERMISSION_DENIED`
4. **Client Timestamp Forgery**: Creating `/savedSegments/seg1` with client-forged `createdAt` instead of `request.time`. -> `PERMISSION_DENIED`
5. **Oversized String Exhaustion**: Creating `/broadcastRequests/req1` with `topic` exceeding 180 characters. -> `PERMISSION_DENIED`
6. **Invalid Document ID Poisoning**: Writing to `/savedSegments/bad.id$123` violating `^[a-zA-Z0-9_-]+$`. -> `PERMISSION_DENIED`
7. **Orphaned Subcollection Write**: Creating `/userProfiles/{uid}/favorites/fav1` when parent `/userProfiles/{uid}` does not exist. -> `PERMISSION_DENIED`
8. **Cross-Tenant Favorite Read**: Reading another user's `/userProfiles/{otherUid}/favorites/fav1`. -> `PERMISSION_DENIED`
9. **Flagged Public Leak**: Creating `/broadcastRequests/req1` with `status: "flagged"` and `isPublicQueue: true`. -> `PERMISSION_DENIED`
10. **Terminal State Tampering**: Updating a `broadcastRequests` doc from `status: "aired"` back to `status: "queued"` as a regular user. -> `PERMISSION_DENIED`
11. **Immutable Author Mutation**: Updating `/savedSegments/seg1` to change `authorId`. -> `PERMISSION_DENIED`
12. **Client Admin Self-Promotion**: Writing to `/admins/{uid}` from the client SDK. -> `PERMISSION_DENIED`
