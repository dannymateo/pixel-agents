import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  CHARACTER_SITTING_OFFSET_PX,
  CONVERSATION_BUBBLE_BG,
  CONVERSATION_BUBBLE_BORDER,
  CONVERSATION_BUBBLE_FONT_PX,
  CONVERSATION_BUBBLE_LINE_HEIGHT_PX,
  CONVERSATION_BUBBLE_LINK,
  CONVERSATION_BUBBLE_MAX_LINES,
  CONVERSATION_BUBBLE_MAX_W,
  CONVERSATION_BUBBLE_TEXT,
  CONVERSATION_BUBBLE_Z_INDEX,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SceneView } from '../engine/conversationScene.js';
import type { OfficeState } from '../engine/officeState.js';
import type { OverlayProjection } from '../projection.js';
import { overlayProjection } from '../projection.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';

/**
 * Conversation bubbles (spec §4b), a DOM overlay over the canvas like
 * ToolOverlay: the speaker's pixel speech bubble with the typewriter text, and
 * a small "…" over the listener while it listens.
 *
 * The text is transcript content from another agent: it is rendered ONLY as a
 * React text child (escaped by React), never as HTML, and the director already
 * caps its length. Clicking the bubble reveals the whole text (a second click
 * closes it); a bubble cut short offers "…ver completo", which opens the
 * speaker's agent screen.
 */
interface ConversationBubbleProps {
  officeState: OfficeState;
  /** The director's running scenes, read every frame (ConversationDirector.views). */
  getViews: () => SceneView[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onSkip: (conversationId: string) => void;
  onOpenScreen: (agentId: number) => void;
}

const bubbleBorder = `2px solid ${CONVERSATION_BUBBLE_BORDER}`;

/** Screen point just above a character's head. */
function headPoint(project: OverlayProjection, ch: Character): { x: number; y: number } {
  const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  return {
    x: project.toScreenX(ch.x),
    y: project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET),
  };
}

/** The little square under a bubble that points at the character. */
function Tail() {
  return (
    <div
      aria-hidden
      style={{
        width: 8,
        height: 8,
        margin: '-2px auto 0',
        background: CONVERSATION_BUBBLE_BG,
        borderRight: bubbleBorder,
        borderBottom: bubbleBorder,
        borderRadius: 0,
      }}
    />
  );
}

function SpeechBubble({
  view,
  at,
  onSkip,
  onOpenScreen,
}: {
  view: SceneView;
  at: { x: number; y: number };
  onSkip: (conversationId: string) => void;
  onOpenScreen: (agentId: number) => void;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  // Follow the typewriter: keep the newest line in view while it types. Once
  // complete the reader owns the scroll.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !view.complete) el.scrollTop = el.scrollHeight;
  }, [view.visibleText, view.complete]);

  const showMore = view.complete && view.truncated;
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-full"
      style={{ left: at.x, top: at.y, zIndex: CONVERSATION_BUBBLE_Z_INDEX, pointerEvents: 'auto' }}
      data-testid="conversation-bubble"
      data-conversation-id={view.conversationId}
      data-agent-id={view.fromId}
      data-kind={view.kind}
    >
      <div
        role="button"
        tabIndex={0}
        title={view.complete ? 'Cerrar' : 'Ver todo el texto'}
        onClick={(e) => {
          e.stopPropagation();
          onSkip(view.conversationId);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSkip(view.conversationId);
          }
        }}
        className="shadow-pixel cursor-pointer"
        style={{
          maxWidth: CONVERSATION_BUBBLE_MAX_W,
          width: 'max-content',
          background: CONVERSATION_BUBBLE_BG,
          color: CONVERSATION_BUBBLE_TEXT,
          border: bubbleBorder,
          borderRadius: 0,
          padding: '4px 6px',
          fontSize: CONVERSATION_BUBBLE_FONT_PX,
          lineHeight: `${CONVERSATION_BUBBLE_LINE_HEIGHT_PX}px`,
        }}
      >
        <div
          ref={textRef}
          data-testid="conversation-text"
          dir="auto"
          style={{
            maxHeight: CONVERSATION_BUBBLE_MAX_LINES * CONVERSATION_BUBBLE_LINE_HEIGHT_PX,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            // Transcript text: its direction marks never leak onto the bubble.
            unicodeBidi: 'isolate',
            overflowWrap: 'anywhere',
          }}
        >
          {view.visibleText}
        </div>
        {showMore && (
          <button
            type="button"
            data-testid="conversation-more"
            onClick={(e) => {
              e.stopPropagation();
              onOpenScreen(view.fromId);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="cursor-pointer underline"
            style={{
              display: 'block',
              marginTop: 2,
              padding: 0,
              background: 'transparent',
              border: 'none',
              borderRadius: 0,
              color: CONVERSATION_BUBBLE_LINK,
              fontSize: CONVERSATION_BUBBLE_FONT_PX,
            }}
          >
            …ver completo
          </button>
        )}
      </div>
      <Tail />
    </div>
  );
}

function ListeningBubble({ at, agentId }: { at: { x: number; y: number }; agentId: number }) {
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-full"
      style={{ left: at.x, top: at.y, zIndex: CONVERSATION_BUBBLE_Z_INDEX, pointerEvents: 'none' }}
      data-testid="conversation-listening"
      data-agent-id={agentId}
    >
      <div
        className="shadow-pixel"
        style={{
          background: CONVERSATION_BUBBLE_BG,
          color: CONVERSATION_BUBBLE_TEXT,
          border: bubbleBorder,
          borderRadius: 0,
          padding: '0 6px',
          fontSize: CONVERSATION_BUBBLE_FONT_PX,
          lineHeight: `${CONVERSATION_BUBBLE_LINE_HEIGHT_PX}px`,
        }}
      >
        …
      </div>
      <Tail />
    </div>
  );
}

export function ConversationBubble({
  officeState,
  getViews,
  containerRef,
  zoom,
  panRef,
  onSkip,
  onOpenScreen,
}: ConversationBubbleProps) {
  // Re-render every frame while a bubble shows (the typewriter and the
  // walkers move continuously), plus one last frame to clear it; otherwise
  // the loop only polls the director.
  const [, setTick] = useState(0);
  const getViewsRef = useRef(getViews);
  useEffect(() => {
    getViewsRef.current = getViews;
  }, [getViews]);
  useEffect(() => {
    let rafId = 0;
    let wasShowing = false;
    const tick = () => {
      const showing = getViewsRef.current().some((v) => v.showBubble);
      if (showing || wasShowing) setTick((n) => n + 1);
      wasShowing = showing;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  const views = getViews().filter((v) => v.showBubble);
  if (views.length === 0) return null;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <>
      {views.map((view) => {
        const speaker = officeState.characters.get(view.fromId);
        if (!speaker) return null;
        const listener =
          view.phase === 'talking' && view.toId !== undefined
            ? officeState.characters.get(view.toId)
            : undefined;
        return (
          <div key={view.conversationId}>
            <SpeechBubble
              view={view}
              at={headPoint(project, speaker)}
              onSkip={onSkip}
              onOpenScreen={onOpenScreen}
            />
            {listener && (
              <ListeningBubble at={headPoint(project, listener)} agentId={listener.id} />
            )}
          </div>
        );
      })}
    </>
  );
}
