import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type {
  BroadcastSegment,
  ChannelCategory,
  ChannelSelection,
  HostId,
  ModerationVerdict,
  ViewerRequest,
} from '../../shared/broadcastTypes';
import type { CartoonStylePreset } from '../components/CartoonBroadcastStage';
import {
  auth,
  db,
  formatQuotaErrorMessage,
  googleProvider,
  handleFirestoreError,
  OperationType,
  testConnection,
} from '../lib/firebase';

export interface SavedSegmentRecord {
  id: string;
  authorId: string;
  channel: ChannelCategory;
  primaryHostId: HostId;
  coHostId?: HostId;
  showTitle: string;
  headline: string;
  subheadline: string;
  summary: string;
  dialogueText: string;
  musicTitle: string;
  musicBpm: number;
  verdict: ModerationVerdict;
  isLiveGrounded: boolean;
  isPublicArchive: boolean;
  createdAtMs: number;
}

export interface ViewerFavoriteRecord {
  id: string;
  userId: string;
  segmentId: string;
  headline: string;
  channel: ChannelCategory;
  showTitle: string;
  createdAtMs: number;
}

export interface TalkMessageRecord {
  id: string;
  userId: string;
  hostId: HostId;
  role: 'user' | 'host';
  text: string;
  channel: ChannelCategory;
  createdAtMs: number;
}

export interface UserProfileRecord {
  uid: string;
  displayName: string;
  preferredChannel: ChannelSelection;
  cartoonStyle: CartoonStylePreset;
}

interface FirebaseContextValue {
  user: User | null;
  authReady: boolean;
  dbConnected: boolean;
  signingIn: boolean;
  authError: string | null;
  profile: UserProfileRecord | null;
  persistedRequests: ViewerRequest[];
  savedSegments: SavedSegmentRecord[];
  favorites: ViewerFavoriteRecord[];
  talkMessages: TalkMessageRecord[];
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  saveBroadcastRequest: (req: ViewerRequest, moderationNotes: string) => Promise<void>;
  saveBroadcastSegment: (seg: BroadcastSegment, isPublicArchive?: boolean) => Promise<void>;
  deleteSavedSegment: (segmentId: string) => Promise<void>;
  toggleFavorite: (seg: BroadcastSegment) => Promise<boolean>;
  saveTalkMessage: (params: {
    id: string;
    hostId: HostId;
    role: 'user' | 'host';
    text: string;
    channel: ChannelCategory;
  }) => Promise<void>;
  clearTalkHistory: () => Promise<void>;
  updatePreferences: (prefs: {
    preferredChannel?: ChannelSelection;
    cartoonStyle?: CartoonStylePreset;
  }) => Promise<void>;
}

const FirebaseContext = createContext<FirebaseContextValue | null>(null);

function sanitizeId(raw: string, maxLen = 64): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, maxLen);
  return cleaned || `id-${Date.now()}`;
}

function timestampToMs(val: unknown): number {
  if (val && typeof (val as Timestamp).toMillis === 'function') {
    return (val as Timestamp).toMillis();
  }
  return Date.now();
}

export function FirebaseProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dbConnected, setDbConnected] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfileRecord | null>(null);
  const [persistedRequests, setPersistedRequests] = useState<ViewerRequest[]>([]);
  const [savedSegments, setSavedSegments] = useState<SavedSegmentRecord[]>([]);
  const [favorites, setFavorites] = useState<ViewerFavoriteRecord[]>([]);
  const [talkMessages, setTalkMessages] = useState<TalkMessageRecord[]>([]);

  useEffect(() => {
    void testConnection().then((ok) => setDbConnected(ok));
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setProfile(null);
        setPersistedRequests([]);
        setSavedSegments([]);
        setFavorites([]);
        setTalkMessages([]);
      }
    });
    return () => unsub();
  }, []);

  // Ensure /userProfiles/{uid} exists once authenticated
  useEffect(() => {
    if (!authReady || !user) return;
    let cancelled = false;

    const ensureProfile = async () => {
      const profilePath = `userProfiles/${user.uid}`;
      const profileRef = doc(db, 'userProfiles', user.uid);
      try {
        const snap = await getDoc(profileRef);
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data() as Partial<UserProfileRecord>;
          setProfile({
            uid: user.uid,
            displayName: (data.displayName || user.displayName || 'PleziDo Member').slice(0, 80),
            preferredChannel:
              data.preferredChannel === 'news' ||
              data.preferredChannel === 'music' ||
              data.preferredChannel === 'culture'
                ? data.preferredChannel
                : 'auto',
            cartoonStyle:
              data.cartoonStyle === 'anime' || data.cartoonStyle === 'lofi'
                ? data.cartoonStyle
                : 'cel',
          });
        } else {
          const displayName = (user.displayName || 'PleziDo Member').trim().slice(0, 80) || 'PleziDo Member';
          await setDoc(profileRef, {
            uid: user.uid,
            displayName,
            preferredChannel: 'auto',
            cartoonStyle: 'cel',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          if (!cancelled) {
            setProfile({
              uid: user.uid,
              displayName,
              preferredChannel: 'auto',
              cartoonStyle: 'cel',
            });
          }
        }
      } catch (err) {
        const quotaMsg = formatQuotaErrorMessage(err instanceof Error ? err.message : String(err));
        if (quotaMsg) {
          setAuthError(quotaMsg);
          return;
        }
        handleFirestoreError(err, OperationType.WRITE, profilePath);
      }
    };

    void ensureProfile();
    return () => {
      cancelled = true;
    };
  }, [authReady, user]);

  // Attach onSnapshot listeners ONLY when auth is ready and user is signed in
  useEffect(() => {
    if (!authReady || !user) return;

    const reqQuery = query(
      collection(db, 'broadcastRequests'),
      where('isPublicQueue', '==', true),
      limit(25)
    );
    const unsubReqs = onSnapshot(
      reqQuery,
      (snap) => {
        const rows: ViewerRequest[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            topic: String(data.topic || ''),
            category:
              data.category === 'music' || data.category === 'culture' ? data.category : 'news',
            requesterName: String(data.requesterName || 'Viewer'),
            status:
              data.status === 'producing' ||
              data.status === 'on-air' ||
              data.status === 'aired' ||
              data.status === 'flagged'
                ? data.status
                : 'queued',
            moderationReason:
              data.status === 'flagged' && typeof data.moderationNotes === 'string'
                ? data.moderationNotes
                : undefined,
            submittedAtMs: timestampToMs(data.createdAt),
            segmentId: typeof data.segmentId === 'string' ? data.segmentId : undefined,
          };
        });
        rows.sort((a, b) => b.submittedAtMs - a.submittedAtMs);
        setPersistedRequests(rows);
      },
      (err) => {
        const quotaMsg = formatQuotaErrorMessage(err.message);
        if (quotaMsg) {
          setAuthError(quotaMsg);
          return;
        }
        handleFirestoreError(err, OperationType.LIST, 'broadcastRequests');
      }
    );

    const segQuery = query(
      collection(db, 'savedSegments'),
      where('isPublicArchive', '==', true),
      limit(24)
    );
    const unsubSegs = onSnapshot(
      segQuery,
      (snap) => {
        const rows: SavedSegmentRecord[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            authorId: String(data.authorId || ''),
            channel:
              data.channel === 'music' || data.channel === 'culture' ? data.channel : 'news',
            primaryHostId:
              data.primaryHostId === 'marcus' || data.primaryHostId === 'sora'
                ? data.primaryHostId
                : 'elena',
            coHostId:
              data.coHostId === 'elena' || data.coHostId === 'marcus' || data.coHostId === 'sora'
                ? data.coHostId
                : undefined,
            showTitle: String(data.showTitle || 'PleziDo TV'),
            headline: String(data.headline || ''),
            subheadline: String(data.subheadline || ''),
            summary: String(data.summary || ''),
            dialogueText: String(data.dialogueText || ''),
            musicTitle: String(data.musicTitle || ''),
            musicBpm: typeof data.musicBpm === 'number' ? data.musicBpm : 88,
            verdict:
              data.verdict === 'cleared-with-caution' ||
              data.verdict === 'flagged-revised' ||
              data.verdict === 'blocked'
                ? data.verdict
                : 'cleared',
            isLiveGrounded: Boolean(data.isLiveGrounded),
            isPublicArchive: Boolean(data.isPublicArchive),
            createdAtMs: timestampToMs(data.createdAt),
          };
        });
        rows.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setSavedSegments(rows);
      },
      (err) => {
        const quotaMsg = formatQuotaErrorMessage(err.message);
        if (quotaMsg) {
          setAuthError(quotaMsg);
          return;
        }
        handleFirestoreError(err, OperationType.LIST, 'savedSegments');
      }
    );

    const favPath = `userProfiles/${user.uid}/favorites`;
    const favQuery = query(
      collection(db, favPath),
      where('userId', '==', user.uid),
      limit(30)
    );
    const unsubFavs = onSnapshot(
      favQuery,
      (snap) => {
        const rows: ViewerFavoriteRecord[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            userId: String(data.userId || user.uid),
            segmentId: String(data.segmentId || ''),
            headline: String(data.headline || ''),
            channel:
              data.channel === 'music' || data.channel === 'culture' ? data.channel : 'news',
            showTitle: String(data.showTitle || 'PleziDo TV'),
            createdAtMs: timestampToMs(data.createdAt),
          };
        });
        rows.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setFavorites(rows);
      },
      (err) => {
        const quotaMsg = formatQuotaErrorMessage(err.message);
        if (quotaMsg) {
          setAuthError(quotaMsg);
          return;
        }
        handleFirestoreError(err, OperationType.LIST, favPath);
      }
    );

    const talkPath = `userProfiles/${user.uid}/talkMessages`;
    const talkQuery = query(
      collection(db, talkPath),
      where('userId', '==', user.uid),
      limit(40)
    );
    const unsubTalk = onSnapshot(
      talkQuery,
      (snap) => {
        const rows: TalkMessageRecord[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            userId: String(data.userId || user.uid),
            hostId:
              data.hostId === 'elena' || data.hostId === 'marcus' ? data.hostId : 'sora',
            role: data.role === 'host' ? 'host' : 'user',
            text: String(data.text || ''),
            channel:
              data.channel === 'news' || data.channel === 'music' ? data.channel : 'culture',
            createdAtMs: timestampToMs(data.createdAt),
          };
        });
        rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
        setTalkMessages(rows);
      },
      (err) => {
        const quotaMsg = formatQuotaErrorMessage(err.message);
        if (quotaMsg) {
          setAuthError(quotaMsg);
          return;
        }
        handleFirestoreError(err, OperationType.LIST, talkPath);
      }
    );

    return () => {
      unsubReqs();
      unsubSegs();
      unsubFavs();
      unsubTalk();
    };
  }, [authReady, user]);

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Unable to sign in with Google right now.'
      );
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signOutUser = useCallback(async () => {
    setAuthError(null);
    await signOut(auth);
  }, []);

  const saveBroadcastRequest = useCallback(
    async (req: ViewerRequest, moderationNotes: string) => {
      if (!user) return;
      const reqId = sanitizeId(req.id, 64);
      const path = `broadcastRequests/${reqId}`;
      const cleanTopic = req.topic.trim().slice(0, 180);
      if (cleanTopic.length < 3) return;
      const cleanName = req.requesterName.trim().slice(0, 40) || 'Viewer';
      const isFlagged = req.status === 'flagged';

      const payload: Record<string, unknown> = {
        id: reqId,
        authorId: user.uid,
        requesterName: cleanName,
        category: req.category,
        topic: cleanTopic,
        status: req.status === 'flagged' ? 'flagged' : 'queued',
        isPublicQueue: !isFlagged,
        moderationNotes: (moderationNotes || 'Cleared for broadcast').slice(0, 300),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (req.segmentId) {
        payload.segmentId = sanitizeId(req.segmentId, 64);
      }

      try {
        await setDoc(doc(db, 'broadcastRequests', reqId), payload);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const saveBroadcastSegment = useCallback(
    async (seg: BroadcastSegment, isPublicArchive = true) => {
      if (!user) return;
      const segId = sanitizeId(seg.id, 64);
      const path = `savedSegments/${segId}`;
      const dialogueText =
        seg.dialogueBeats
          .map((b) => `${b.speakerName}: ${b.text}`)
          .join('\n')
          .slice(0, 2500) || seg.headline.slice(0, 180);

      const payload: Record<string, unknown> = {
        id: segId,
        authorId: user.uid,
        channel: seg.channel,
        primaryHostId: seg.primaryHostId,
        showTitle: seg.showTitle.slice(0, 80) || 'PleziDo TV',
        headline: seg.headline.slice(0, 180) || 'Live Broadcast',
        subheadline: seg.subheadline.slice(0, 220) || seg.showTitle.slice(0, 80),
        summary: seg.summary.slice(0, 500),
        dialogueText,
        musicTitle: seg.musicScore.title.slice(0, 100) || 'PleziDo Studio Bed',
        musicBpm: Math.min(220, Math.max(40, Math.round(seg.musicScore.bpm || 88))),
        verdict: seg.moderation.verdict,
        isLiveGrounded: Boolean(seg.isLiveGrounded),
        isPublicArchive: Boolean(isPublicArchive),
        createdAt: serverTimestamp(),
      };
      if (seg.coHostId) {
        payload.coHostId = seg.coHostId;
      }

      try {
        await setDoc(doc(db, 'savedSegments', segId), payload);
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const deleteSavedSegment = useCallback(
    async (segmentId: string) => {
      if (!user) return;
      const cleanId = sanitizeId(segmentId, 64);
      const path = `savedSegments/${cleanId}`;
      try {
        await deleteDoc(doc(db, 'savedSegments', cleanId));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    },
    [user]
  );

  const toggleFavorite = useCallback(
    async (seg: BroadcastSegment): Promise<boolean> => {
      if (!user) return false;
      const favId = sanitizeId(seg.id, 64);
      const path = `userProfiles/${user.uid}/favorites/${favId}`;
      const existingFav = favorites.find((f) => f.id === favId);

      try {
        if (existingFav) {
          await deleteDoc(doc(db, path));
          return false;
        }
        await setDoc(doc(db, path), {
          id: favId,
          userId: user.uid,
          segmentId: favId,
          headline: seg.headline.slice(0, 180) || 'Live Broadcast',
          channel: seg.channel,
          showTitle: seg.showTitle.slice(0, 80) || 'PleziDo TV',
          createdAt: serverTimestamp(),
        });
        return true;
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, path);
      }
    },
    [favorites, user]
  );

  const saveTalkMessage = useCallback(
    async (params: {
      id: string;
      hostId: HostId;
      role: 'user' | 'host';
      text: string;
      channel: ChannelCategory;
    }) => {
      if (!user) return;
      const msgId = sanitizeId(params.id, 64);
      const path = `userProfiles/${user.uid}/talkMessages/${msgId}`;
      const cleanText = params.text.trim().slice(0, 1200);
      if (!cleanText) return;

      try {
        await setDoc(doc(db, path), {
          id: msgId,
          userId: user.uid,
          hostId: params.hostId,
          role: params.role,
          text: cleanText,
          channel: params.channel,
          createdAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }
    },
    [user]
  );

  const clearTalkHistory = useCallback(async () => {
    if (!user) return;
    for (const msg of talkMessages) {
      const path = `userProfiles/${user.uid}/talkMessages/${msg.id}`;
      try {
        await deleteDoc(doc(db, path));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, path);
      }
    }
  }, [talkMessages, user]);

  const updatePreferences = useCallback(
    async (prefs: {
      preferredChannel?: ChannelSelection;
      cartoonStyle?: CartoonStylePreset;
    }) => {
      if (!user) return;
      const path = `userProfiles/${user.uid}`;
      const updatePayload: Record<string, unknown> = {
        updatedAt: serverTimestamp(),
      };
      if (prefs.preferredChannel) updatePayload.preferredChannel = prefs.preferredChannel;
      if (prefs.cartoonStyle) updatePayload.cartoonStyle = prefs.cartoonStyle;

      try {
        await updateDoc(doc(db, path), updatePayload);
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                preferredChannel: prefs.preferredChannel ?? prev.preferredChannel,
                cartoonStyle: prefs.cartoonStyle ?? prev.cartoonStyle,
              }
            : prev
        );
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, path);
      }
    },
    [user]
  );

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authReady,
        dbConnected,
        signingIn,
        authError,
        profile,
        persistedRequests,
        savedSegments,
        favorites,
        talkMessages,
        signInWithGoogle,
        signOutUser,
        saveBroadcastRequest,
        saveBroadcastSegment,
        deleteSavedSegment,
        toggleFavorite,
        saveTalkMessage,
        clearTalkHistory,
        updatePreferences,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase(): FirebaseContextValue {
  const ctx = useContext(FirebaseContext);
  if (!ctx) {
    throw new Error('useFirebase must be used inside a FirebaseProvider');
  }
  return ctx;
}
