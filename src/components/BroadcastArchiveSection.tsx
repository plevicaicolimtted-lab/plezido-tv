import { Bookmark, BookmarkCheck, Database, LogIn, LogOut, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { BroadcastSegment, ChannelCategory } from '../../shared/broadcastTypes';
import { useFirebase } from '../contexts/FirebaseContext';

interface BroadcastArchiveSectionProps {
  currentSegment: BroadcastSegment | null;
  sectionId?: string;
  onTuneChannel?: (channel: ChannelCategory) => void;
}

export function BroadcastArchiveSection({
  currentSegment,
  sectionId = 'database-archive',
  onTuneChannel,
}: BroadcastArchiveSectionProps) {
  const {
    user,
    authReady,
    dbConnected,
    signingIn,
    authError,
    savedSegments,
    favorites,
    persistedRequests,
    signInWithGoogle,
    signOutUser,
    saveBroadcastSegment,
    deleteSavedSegment,
    toggleFavorite,
  } = useFirebase();

  const [savingSeg, setSavingSeg] = useState(false);
  const [togglingFav, setTogglingFav] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const isCurrentFavorited = Boolean(
    currentSegment && favorites.some((f) => f.segmentId === currentSegment.id)
  );
  const isCurrentArchived = Boolean(
    currentSegment && savedSegments.some((s) => s.id === currentSegment.id)
  );

  const handleSaveCurrent = async () => {
    if (!currentSegment || savingSeg) return;
    setSavingSeg(true);
    setStatusMessage(null);
    try {
      await saveBroadcastSegment(currentSegment, true);
      setStatusMessage('Broadcast archived to Firestore database.');
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Unable to save broadcast to Firestore.'
      );
    } finally {
      setSavingSeg(false);
    }
  };

  const handleFavoriteCurrent = async () => {
    if (!currentSegment || togglingFav) return;
    setTogglingFav(true);
    setStatusMessage(null);
    try {
      const added = await toggleFavorite(currentSegment);
      setStatusMessage(added ? 'Added to your Saved Shows.' : 'Removed from Saved Shows.');
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Unable to update Saved Shows.'
      );
    } finally {
      setTogglingFav(false);
    }
  };

  return (
    <section
      id={sectionId}
      className="mx-auto max-w-[1440px] px-4 sm:px-6 py-10 border-t border-white/[0.08]"
    >
      <div className="mb-7 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Database className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            <span>
              Firestore Cloud Database · {dbConnected ? 'Connected' : 'Offline Fallback'}
            </span>
          </div>
          <h2 className="mt-1 font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Broadcast Archive &amp; Saved Shows
          </h2>
          <p className="mt-1.5 text-sm text-slate-400 max-w-2xl">
            Persist aired broadcasts, favorite segments, audience requests, and AI host talk
            history across your devices.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {!authReady ? (
            <span className="text-xs text-slate-400">Checking session…</span>
          ) : user ? (
            <>
              {currentSegment && (
                <>
                  <button
                    type="button"
                    disabled={savingSeg || isCurrentArchived}
                    onClick={() => void handleSaveCurrent()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-[#121722] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1B2334] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Database className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                    <span>
                      {isCurrentArchived
                        ? 'Archived in DB'
                        : savingSeg
                          ? 'Saving…'
                          : 'Archive Live Segment'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={togglingFav}
                    onClick={() => void handleFavoriteCurrent()}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      isCurrentFavorited
                        ? 'border-[#E11D48]/60 bg-[#E11D48]/15 text-white'
                        : 'border-white/15 bg-[#121722] text-slate-200 hover:bg-[#1B2334]'
                    }`}
                  >
                    {isCurrentFavorited ? (
                      <BookmarkCheck className="h-3.5 w-3.5 text-[#FB7185]" aria-hidden="true" />
                    ) : (
                      <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                    <span>{isCurrentFavorited ? 'Saved Show' : 'Save Show'}</span>
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => void signOutUser()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Sign Out ({user.displayName?.split(' ')[0] || 'Account'})</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={signingIn}
              onClick={() => void signInWithGoogle()}
              className="inline-flex items-center gap-2 rounded-lg bg-[#E11D48] px-4 py-2 text-xs font-semibold text-white hover:bg-[#BE123C] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{signingIn ? 'Signing In…' : 'Sign In With Google to Sync DB'}</span>
            </button>
          )}
        </div>
      </div>

      {(authError || statusMessage) && (
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-xs ${
            authError
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-200'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
          }`}
        >
          {authError || statusMessage}
        </div>
      )}

      {!user ? (
        <div className="rounded-xl border border-white/[0.08] bg-[#0B0F17] p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-semibold text-white">
              Cloud Sync Ready (Firestore Database Active)
            </h3>
            <p className="mt-1 text-sm text-slate-400">
              Sign in with your Google account to save broadcasts to Firestore, bookmark shows,
              and sync viewer topic requests across phone and desktop.
            </p>
          </div>
          <button
            type="button"
            disabled={signingIn}
            onClick={() => void signInWithGoogle()}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-xs font-semibold text-[#06080D] hover:bg-slate-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{signingIn ? 'Connecting…' : 'Connect Google Account'}</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Persisted Broadcast Archive */}
          <div className="lg:col-span-8 rounded-xl border border-white/[0.08] bg-[#0B0F17] overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
              <span className="text-sm font-semibold text-white">
                Archived Broadcasts ({savedSegments.length})
              </span>
              <span className="text-xs font-mono-tabular text-slate-400">
                {persistedRequests.length} DB Queue Items
              </span>
            </div>

            {savedSegments.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                No broadcasts archived yet. Click “Archive Live Segment” above or air a new
                script to store broadcasts in Firestore.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.06] max-h-[380px] overflow-y-auto">
                {savedSegments.map((seg) => (
                  <div
                    key={seg.id}
                    className="p-4 sm:px-5 hover:bg-white/[0.02] transition-colors flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="font-semibold text-white">{seg.showTitle}</span>
                        <span aria-hidden="true">·</span>
                        <span className="capitalize">{seg.channel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono-tabular">
                          {seg.musicTitle} ({seg.musicBpm} BPM)
                        </span>
                      </div>
                      <h3 className="mt-1 font-display text-base font-semibold text-white">
                        {seg.headline}
                      </h3>
                      <p className="mt-1 text-xs text-slate-400 line-clamp-2">
                        {seg.subheadline}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {onTuneChannel && (
                        <button
                          type="button"
                          onClick={() => onTuneChannel(seg.channel)}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:border-white/25 hover:text-white transition-colors"
                        >
                          <Play className="h-3 w-3" aria-hidden="true" />
                          <span>Watch</span>
                        </button>
                      )}

                      {seg.authorId === user.uid && (
                        <button
                          type="button"
                          aria-label={`Remove ${seg.headline}`}
                          onClick={() => void deleteSavedSegment(seg.id)}
                          className="rounded-lg border border-white/10 p-2 text-slate-400 hover:border-rose-500/40 hover:text-rose-300 transition-colors shrink-0"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* User Saved Favorites */}
          <div className="lg:col-span-4 rounded-xl border border-white/[0.08] bg-[#0B0F17] overflow-hidden">
            <div className="border-b border-white/[0.08] bg-[#0F131C] px-5 py-3.5">
              <span className="text-sm font-semibold text-white">
                Your Saved Shows ({favorites.length})
              </span>
            </div>

            {favorites.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                Bookmark any live show using “Save Show” to keep it in your personal library.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.06] max-h-[380px] overflow-y-auto">
                {favorites.map((fav) => (
                  <div key={fav.id} className="p-4 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                      <span className="font-semibold text-white">{fav.showTitle}</span>
                      <div className="flex items-center gap-2">
                        <span className="capitalize">{fav.channel}</span>
                        {onTuneChannel && (
                          <button
                            type="button"
                            onClick={() => onTuneChannel(fav.channel)}
                            className="text-xs font-medium text-[#FB7185] hover:text-white transition-colors"
                          >
                            Tune In
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-sm font-medium text-slate-200 line-clamp-2">
                      {fav.headline}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
