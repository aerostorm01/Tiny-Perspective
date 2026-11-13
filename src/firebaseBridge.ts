import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  deleteUser,
  setPersistence,
  browserLocalPersistence,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface PlayerProfile {
  uid: string;
  username: string;
  usernameLower: string;
  avatar: string;
  createdAt?: unknown;
}

export interface GameBoardMeta {
  id: string;
  name: string;
  emoji: string;
  direction: 'higher' | 'lower';
  unit: string;
  toyId: string;
  min: number;
  max: number;
  maxScorePerSecond: number;
}

export interface AuthStatePayload {
  state: 'loading' | 'signed_out' | 'needs_username' | 'ready';
  fbUser: { uid: string; displayName: string | null } | null;
  profile: PlayerProfile | null;
}

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const persistenceReady = setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('Auth persistence setup warning:', err);
});

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function getIsoWeekKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${(weekNo < 10 ? '0' : '') + weekNo}`;
}

const RESERVED_USERNAMES = ['admin', 'moderator', 'support', 'claude', 'system', 'null', 'root', 'staff'];
const PROFANITY_LIST = ['fuck', 'shit', 'bitch', 'cunt', 'asshole', 'nigger', 'faggot', 'retard'];
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,15}$/;

let cachedProfile: PlayerProfile | null = null;
let currentAuthState: AuthStatePayload = { state: 'loading', fbUser: null, profile: null };
const authListeners = new Set<(payload: AuthStatePayload) => void>();

function notifyListeners(payload: AuthStatePayload) {
  currentAuthState = payload;
  authListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error('Auth listener error:', e);
    }
  });
}

async function fetchProfileDoc(uid: string): Promise<PlayerProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      uid,
      username: String(data.username || ''),
      usernameLower: String(data.usernameLower || ''),
      avatar: String(data.avatar || '🦊'),
      createdAt: data.createdAt,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

onAuthStateChanged(auth, async (fbUser: User | null) => {
  await persistenceReady;
  if (!fbUser) {
    cachedProfile = null;
    notifyListeners({ state: 'signed_out', fbUser: null, profile: null });
    return;
  }

  try {
    const prof = await fetchProfileDoc(fbUser.uid);
    if (prof && prof.username) {
      cachedProfile = prof;
      notifyListeners({
        state: 'ready',
        fbUser: { uid: fbUser.uid, displayName: fbUser.displayName },
        profile: prof,
      });
    } else {
      cachedProfile = null;
      notifyListeners({
        state: 'needs_username',
        fbUser: { uid: fbUser.uid, displayName: fbUser.displayName },
        profile: null,
      });
    }
  } catch (err) {
    console.error('Failed loading user profile:', err);
    cachedProfile = null;
    notifyListeners({
      state: 'needs_username',
      fbUser: { uid: fbUser.uid, displayName: fbUser.displayName },
      profile: null,
    });
  }
});

export const TPFirebase = {
  isDemo: () => false,

  getCurrentUid: () => auth.currentUser?.uid || null,

  getCachedProfile: () => cachedProfile,

  onAuthChange: (cb: (payload: AuthStatePayload) => void) => {
    authListeners.add(cb);
    cb(currentAuthState);
    return () => {
      authListeners.delete(cb);
    };
  },

  signInWithGoogle: async () => {
    await persistenceReady;
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    const prof = await fetchProfileDoc(cred.user.uid);
    if (prof && prof.username) {
      cachedProfile = prof;
      notifyListeners({
        state: 'ready',
        fbUser: { uid: cred.user.uid, displayName: cred.user.displayName },
        profile: prof,
      });
      return { state: 'ready' as const, profile: prof };
    }
    notifyListeners({
      state: 'needs_username',
      fbUser: { uid: cred.user.uid, displayName: cred.user.displayName },
      profile: null,
    });
    return { state: 'needs_username' as const, profile: null };
  },

  signOut: async () => {
    cachedProfile = null;
    await firebaseSignOut(auth);
  },

  isUsernameAvailable: async (rawUsername: string): Promise<boolean> => {
    const clean = String(rawUsername || '').trim().replace(/^@+/, '');
    if (!USERNAME_RE.test(clean)) return false;
    const lower = clean.toLowerCase();
    if (RESERVED_USERNAMES.includes(lower) || PROFANITY_LIST.some((p) => lower.includes(p))) {
      return false;
    }
    if (!auth.currentUser) return true;

    const path = `usernames/${lower}`;
    try {
      const snap = await getDoc(doc(db, 'usernames', lower));
      return !snap.exists();
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  claimUsername: async ({ username, avatar }: { username: string; avatar: string }): Promise<PlayerProfile> => {
    const user = auth.currentUser;
    if (!user) throw new Error('Please sign in with Google first.');

    const clean = String(username || '').trim().replace(/^@+/, '');
    if (!USERNAME_RE.test(clean)) {
      throw new Error('Username must be 3–16 characters, start with a letter, and contain only letters, numbers, or underscores.');
    }
    const lower = clean.toLowerCase();
    if (RESERVED_USERNAMES.includes(lower) || PROFANITY_LIST.some((p) => lower.includes(p))) {
      throw new Error('That username is reserved or not allowed. Please pick another.');
    }

    const safeAvatar = String(avatar || '🦊').trim().slice(0, 16) || '🦊';

    // Check availability cleanly first
    const usernameRef = doc(db, 'usernames', lower);
    try {
      const existingSnap = await getDoc(usernameRef);
      if (existingSnap.exists()) {
        throw new Error('That username is already taken. Try another one.');
      }
    } catch (err: any) {
      if (err?.message?.includes('already taken')) throw err;
      handleFirestoreError(err, OperationType.GET, `usernames/${lower}`);
    }

    const userRef = doc(db, 'users', user.uid);
    const batch = writeBatch(db);
    batch.set(usernameRef, {
      uid: user.uid,
      username: clean,
      usernameLower: lower,
      avatar: safeAvatar,
      createdAt: serverTimestamp(),
    });
    batch.set(userRef, {
      uid: user.uid,
      username: clean,
      usernameLower: lower,
      avatar: safeAvatar,
      createdAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('already-exists')) {
        // Re-check if username was claimed concurrently
        try {
          const recheck = await getDoc(usernameRef);
          if (recheck.exists() && recheck.data()?.uid !== user.uid) {
            throw new Error('That username was just claimed by another player. Please choose another.');
          }
        } catch (reErr: any) {
          if (reErr?.message?.includes('just claimed')) throw reErr;
        }
      }
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
    }

    const profile: PlayerProfile = {
      uid: user.uid,
      username: clean,
      usernameLower: lower,
      avatar: safeAvatar,
    };
    cachedProfile = profile;
    notifyListeners({
      state: 'ready',
      fbUser: { uid: user.uid, displayName: user.displayName },
      profile,
    });
    return profile;
  },

  getProfile: async (uid: string): Promise<PlayerProfile | null> => {
    if (!uid) return null;
    return await fetchProfileDoc(uid);
  },

  updateAvatar: async (avatar: string): Promise<PlayerProfile | null> => {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in.');
    const safeAvatar = String(avatar || '🦊').trim().slice(0, 16) || '🦊';
    const prof = cachedProfile || (await fetchProfileDoc(user.uid));
    if (!prof) throw new Error('Player profile not found.');

    const batch = writeBatch(db);
    batch.update(doc(db, 'users', user.uid), { avatar: safeAvatar });
    batch.update(doc(db, 'usernames', prof.usernameLower), { avatar: safeAvatar });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    }

    const updated: PlayerProfile = { ...prof, avatar: safeAvatar };
    cachedProfile = updated;
    notifyListeners({
      state: 'ready',
      fbUser: { uid: user.uid, displayName: user.displayName },
      profile: updated,
    });
    return updated;
  },

  deleteMyAccount: async (boardIds: string[] = []) => {
    const user = auth.currentUser;
    if (!user) return;
    const uid = user.uid;
    const prof = cachedProfile || (await fetchProfileDoc(uid).catch(() => null));

    // Delete personal score history
    try {
      const scoreSnaps = await getDocs(collection(db, 'users', uid, 'scores'));
      for (const d of scoreSnaps.docs) {
        await deleteDoc(d.ref).catch(() => {});
      }
    } catch (_) {}

    // Delete leaderboard entries for known boards
    const weekKey = getIsoWeekKey();
    for (const bId of boardIds) {
      await deleteDoc(doc(db, 'leaderboards', bId, 'entries', uid)).catch(() => {});
      await deleteDoc(doc(db, 'weekly', `${bId}__${weekKey}`, 'entries', uid)).catch(() => {});
    }

    if (prof?.usernameLower) {
      await deleteDoc(doc(db, 'usernames', prof.usernameLower)).catch(() => {});
    }
    await deleteDoc(doc(db, 'users', uid)).catch(() => {});

    cachedProfile = null;
    try {
      await deleteUser(user);
    } catch (err) {
      // If re-auth is required by Firebase Auth, sign out cleanly after wiping Firestore profile
      await firebaseSignOut(auth);
      throw err;
    }
  },

  loadMyCloudScores: async (): Promise<Record<string, any>> => {
    const user = auth.currentUser;
    if (!user) return {};
    const path = `users/${user.uid}/scores`;
    try {
      const snap = await getDocs(collection(db, 'users', user.uid, 'scores'));
      const out: Record<string, any> = {};
      snap.docs.forEach((d) => {
        const data = d.data();
        out[d.id] = {
          best: Number(data.best),
          bestDate: Number(data.bestDate) || Date.now(),
          plays: Number(data.plays) || 1,
          last10: Array.isArray(data.last10) ? data.last10 : [],
          totalTimeMs: Number(data.totalTimeMs) || 0,
          lastPlayedAt: Number(data.lastPlayedAt) || Date.now(),
        };
      });
      return out;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  submitScore: async (board: GameBoardMeta, score: number, durationMs = 0) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in');
    const numScore = Number(score);
    if (!Number.isFinite(numScore) || numScore < board.min || numScore > board.max) {
      return { success: false, reason: 'Score out of range' };
    }

    const prof = cachedProfile || (await fetchProfileDoc(user.uid));
    if (!prof || !prof.username) {
      throw new Error('Claim your permanent username first.');
    }

    const dur = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0
      ? Math.min(86400000, Math.round(Number(durationMs)))
      : 0;
    const now = Date.now();

    // 1. Update permanent personal score history at users/{uid}/scores/{boardId}
    const personalRef = doc(db, 'users', user.uid, 'scores', board.id);
    let isNewPersonalBest = false;
    try {
      const pSnap = await getDoc(personalRef);
      let nextBest = numScore;
      let nextBestDate = now;
      let nextPlays = 1;
      let nextTimeMs = dur;
      let nextLast10: Array<{ score: number; at: number }> = [{ score: numScore, at: now }];

      if (pSnap.exists()) {
        const prev = pSnap.data();
        const prevBest = Number(prev.best);
        const better =
          !Number.isFinite(prevBest) ||
          (board.direction === 'higher' ? numScore > prevBest : numScore < prevBest);
        isNewPersonalBest = better;
        nextBest = better ? numScore : prevBest;
        nextBestDate = better ? now : (Number(prev.bestDate) || now);
        nextPlays = (Number(prev.plays) || 0) + 1;
        nextTimeMs = (Number(prev.totalTimeMs) || 0) + dur;
        const prevList = Array.isArray(prev.last10)
          ? prev.last10
              .filter((x: any) => x && Number.isFinite(Number(x.score)) && Number.isFinite(Number(x.at)))
              .map((x: any) => ({ score: Number(x.score), at: Number(x.at) }))
          : [];
        prevList.push({ score: numScore, at: now });
        nextLast10 = prevList.slice(-10);
      } else {
        isNewPersonalBest = true;
      }

      await setDoc(personalRef, {
        boardId: board.id,
        best: nextBest,
        bestDate: nextBestDate,
        plays: nextPlays,
        totalTimeMs: nextTimeMs,
        lastPlayedAt: now,
        last10: nextLast10,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/scores/${board.id}`);
    }

    // 2. Update All-Time & Weekly leaderboards if better (or if no entry exists yet)
    const weekKey = getIsoWeekKey();
    const allRef = doc(db, 'leaderboards', board.id, 'entries', user.uid);
    const weeklyRef = doc(db, 'weekly', `${board.id}__${weekKey}`, 'entries', user.uid);

    let writeAll = false;
    let writeWeekly = false;
    try {
      const [allSnap, weekSnap] = await Promise.all([getDoc(allRef), getDoc(weeklyRef)]);
      if (!allSnap.exists()) {
        writeAll = true;
      } else {
        const oldScore = Number(allSnap.data().score);
        writeAll = board.direction === 'higher' ? numScore > oldScore : numScore < oldScore;
      }

      if (!weekSnap.exists()) {
        writeWeekly = true;
      } else {
        const oldWeekScore = Number(weekSnap.data().score);
        writeWeekly = board.direction === 'higher' ? numScore > oldWeekScore : numScore < oldWeekScore;
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `leaderboards/${board.id}/entries/${user.uid}`);
    }

    if (writeAll || writeWeekly) {
      const entry = {
        uid: user.uid,
        username: prof.username,
        avatar: prof.avatar || '🦊',
        score: numScore,
        durationMs: dur,
        updatedAt: serverTimestamp(),
      };
      const batch = writeBatch(db);
      if (writeAll) batch.set(allRef, entry);
      if (writeWeekly) batch.set(weeklyRef, entry);
      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `leaderboards/${board.id}/entries/${user.uid}`);
      }
    }

    return { success: true, newBest: writeAll || isNewPersonalBest, newWeeklyBest: writeWeekly };
  },

  getLeaderboard: async (boardId: string, type: 'all' | 'weekly', direction: 'higher' | 'lower') => {
    const weekKey = getIsoWeekKey();
    const colPath = type === 'weekly' ? `weekly/${boardId}__${weekKey}/entries` : `leaderboards/${boardId}/entries`;
    try {
      const q = query(
        collection(db, colPath),
        where('score', '>=', 0),
        orderBy('score', direction === 'higher' ? 'desc' : 'asc'),
        limit(20)
      );
      const snap = await getDocs(q);
      return snap.docs.map((d) => d.data());
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, colPath);
    }
  },

  getMyBest: async (boardId: string) => {
    const user = auth.currentUser;
    if (!user) return null;
    const path = `leaderboards/${boardId}/entries/${user.uid}`;
    try {
      const snap = await getDoc(doc(db, 'leaderboards', boardId, 'entries', user.uid));
      return snap.exists() ? snap.data() : null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  getMyRank: async (boardId: string, score: number, direction: 'higher' | 'lower') => {
    if (score === undefined || score === null || !Number.isFinite(Number(score))) return '-';
    const path = `leaderboards/${boardId}/entries`;
    try {
      const colRef = collection(db, 'leaderboards', boardId, 'entries');
      const cond = direction === 'higher' ? where('score', '>', Number(score)) : where('score', '<', Number(score));
      const snap = await getDocs(query(colRef, where('score', '>=', 0), cond));
      return snap.size + 1;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  searchUsernames: async (prefix: string) => {
    const clean = String(prefix || '').trim().replace(/^@+/, '').toLowerCase();
    const path = 'usernames';
    try {
      const q = clean
        ? query(
            collection(db, 'usernames'),
            where('usernameLower', '>=', clean),
            where('usernameLower', '<=', clean + '\uf8ff'),
            limit(8)
          )
        : query(
            collection(db, 'usernames'),
            where('usernameLower', '>=', ''),
            limit(8)
          );
      const snap = await getDocs(q);
      const myUid = auth.currentUser?.uid || null;
      return snap.docs
        .map((d) => {
          const data = d.data();
          return {
            uid: String(data.uid),
            username: String(data.username || d.id),
            avatar: String(data.avatar || '🦊'),
          };
        })
        .filter((u) => !myUid || u.uid !== myUid);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  findUserByExactUsername: async (rawUsername: string) => {
    const clean = String(rawUsername || '').trim().replace(/^@+/, '').toLowerCase();
    if (!clean || clean.length < 3) return null;
    const path = `usernames/${clean}`;
    try {
      const snap = await getDoc(doc(db, 'usernames', clean));
      if (!snap.exists()) return null;
      const data = snap.data();
      return {
        uid: String(data.uid),
        username: String(data.username || clean),
        avatar: String(data.avatar || '🦊'),
      };
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  },

  sendShare: async ({
    recipientUid,
    recipientUsername,
    type,
    gameId,
    score,
    note,
  }: {
    recipientUid?: string;
    recipientUsername?: string;
    type: 'score' | 'challenge' | 'result';
    gameId: string;
    score: number;
    note?: string;
  }) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in');
    const sender = cachedProfile || (await fetchProfileDoc(user.uid));
    if (!sender) throw new Error('Claim your permanent username first.');

    let targetUid = recipientUid || '';
    let targetUsername = (recipientUsername || '').trim().replace(/^@+/, '');

    if (!targetUid && targetUsername) {
      const found = await TPFirebase.findUserByExactUsername(targetUsername);
      if (!found) throw new Error(`No player found with username "@${targetUsername}".`);
      targetUid = found.uid;
      targetUsername = found.username;
    }

    if (!targetUid) throw new Error('Please choose a recipient username.');
    if (targetUid === sender.uid) throw new Error('You cannot send a score challenge to yourself.');

    if (!targetUsername) {
      const recProf = await fetchProfileDoc(targetUid);
      if (!recProf) throw new Error('Recipient player not found.');
      targetUsername = recProf.username;
    }

    const now = Date.now();
    const shareLogKey = `tp_shares_${sender.uid}`;
    try {
      let shares: number[] = JSON.parse(localStorage.getItem(shareLogKey) || '[]');
      shares = shares.filter((ts) => now - ts < 3600000);
      if (shares.length >= 10) {
        throw new Error('Share limit reached (10 per hour). Please wait before sharing again.');
      }
      shares.push(now);
      localStorage.setItem(shareLogKey, JSON.stringify(shares));
    } catch (e: any) {
      if (e?.message?.includes('Share limit')) throw e;
    }

    const itemRef = doc(collection(db, 'inbox', targetUid, 'items'));
    const path = `inbox/${targetUid}/items/${itemRef.id}`;
    const safeNote = String(note || '').trim().slice(0, 120);

    try {
      await setDoc(itemRef, {
        type: type || 'challenge',
        senderUid: sender.uid,
        senderUsername: sender.username,
        senderAvatar: sender.avatar || '🦊',
        recipientUsername: targetUsername,
        gameId: String(gameId),
        score: Number(score),
        note: safeNote,
        read: false,
        createdAt: serverTimestamp(),
        expiresAt: now + 7 * 86400000,
      });
      return true;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  },

  listInbox: async () => {
    const user = auth.currentUser;
    if (!user) return [];
    const path = `inbox/${user.uid}/items`;
    try {
      const q = query(collection(db, 'inbox', user.uid, 'items'), orderBy('createdAt', 'desc'), limit(50));
      const snap = await getDocs(q);
      return snap.docs.map((d) => {
        const data = d.data();
        const createdMs =
          data.createdAt && typeof data.createdAt.toMillis === 'function'
            ? data.createdAt.toMillis()
            : Number(data.createdAt) || Date.now();
        return { id: d.id, ...data, createdAt: createdMs };
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  },

  subscribeInboxUnread: (cb: (unreadCount: number) => void): Unsubscribe => {
    const user = auth.currentUser;
    if (!user) {
      cb(0);
      return () => {};
    }
    const path = `inbox/${user.uid}/items`;
    const q = query(collection(db, 'inbox', user.uid, 'items'), where('read', '==', false), limit(50));
    return onSnapshot(
      q,
      (snap) => {
        cb(snap.size);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    );
  },

  markRead: async (itemId: string) => {
    const user = auth.currentUser;
    if (!user) return;
    const path = `inbox/${user.uid}/items/${itemId}`;
    try {
      await updateDoc(doc(db, 'inbox', user.uid, 'items', itemId), { read: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
  },

  deleteInboxItem: async (itemId: string) => {
    const user = auth.currentUser;
    if (!user) return;
    const path = `inbox/${user.uid}/items/${itemId}`;
    try {
      await deleteDoc(doc(db, 'inbox', user.uid, 'items', itemId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  },

  blockUser: async (targetUid: string) => {
    const user = auth.currentUser;
    if (!user) return;
    const path = `blocks/${user.uid}/users/${targetUid}`;
    try {
      await setDoc(doc(db, 'blocks', user.uid, 'users', targetUid), { blockedAt: serverTimestamp() });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
  },

  reportUser: async (targetUid: string, reason: string) => {
    const user = auth.currentUser;
    if (!user) return;
    const ref = doc(collection(db, 'reports'));
    const path = `reports/${ref.id}`;
    try {
      await setDoc(ref, {
        reporterUid: user.uid,
        targetUid,
        reason: String(reason || '').slice(0, 300),
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  },
};

(window as any).TP_FIREBASE = TPFirebase;
