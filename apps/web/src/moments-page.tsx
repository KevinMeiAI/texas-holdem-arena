import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiRequest } from "./api";
import { EmptyState, ErrorBlock, LoadingBlock, SectionHeading } from "./components";
import {
  mergeMomentIndexItems,
  momentFilterScrollBehavior,
  momentIndexApiPath,
  momentIndexHref,
  nearestMomentFilterScrollLeft,
  parseMomentIndexTag,
  type MomentIndexTag,
  type PublicMomentIndexItem,
  type PublicMomentIndexResponse,
} from "./moments-index-model";
import { TournamentMomentCard } from "./tournament-moments";
import { useUiPreferences } from "./ui-preferences";

const MOMENT_INDEX_FILTERS: readonly {
  tag: MomentIndexTag | null;
  zh: string;
  en: string;
}[] = [
  { tag: null, zh: "全部", en: "All" },
  { tag: "ALL_IN", zh: "全下", en: "All-in" },
  { tag: "ELIMINATION", zh: "淘汰", en: "Elimination" },
  { tag: "LEAD_CHANGE", zh: "领先易主", en: "Lead swing" },
  { tag: "FINAL_HAND", zh: "决胜手", en: "Final hand" },
  { tag: "LARGE_POT", zh: "大底池", en: "Large pot" },
];

function requestFailed(reason: unknown, signal: AbortSignal): boolean {
  return !signal.aborted && !(reason instanceof DOMException && reason.name === "AbortError");
}

export function MomentsPage() {
  const { text } = useUiPreferences();
  const [searchParams] = useSearchParams();
  const activeTag = parseMomentIndexTag(searchParams.get("tag"));
  const [contentTag, setContentTag] = useState<MomentIndexTag | null>(activeTag);
  const [items, setItems] = useState<PublicMomentIndexItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialError, setInitialError] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const requestGeneration = useRef(0);
  const initialController = useRef<AbortController | null>(null);
  const pageController = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const filterNavRef = useRef<HTMLElement>(null);
  const activeFilterRef = useRef<HTMLAnchorElement>(null);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const nav = filterNavRef.current;
    const active = activeFilterRef.current;
    if (!nav || !active) return;
    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const left = nearestMomentFilterScrollLeft(
      {
        scrollLeft: nav.scrollLeft,
        clientWidth: nav.clientWidth,
        scrollWidth: nav.scrollWidth,
      },
      {
        offsetLeft: nav.scrollLeft + activeRect.left - navRect.left,
        offsetWidth: activeRect.width,
      },
    );
    if (Math.abs(left - nav.scrollLeft) < 1) return;
    nav.scrollTo({
      left,
      behavior: momentFilterScrollBehavior(
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    });
  }, [activeTag]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${text("精彩瞬间", "Highlights")} · ${text("德扑竞技场", "Hold'em Arena")}`;
    return () => { document.title = previousTitle; };
  }, [text]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    initialController.current?.abort();
    pageController.current?.abort();
    const controller = new AbortController();
    initialController.current = controller;
    setContentTag(activeTag);
    setItems([]);
    setNextCursor(null);
    setInitialError(false);
    setPageError(false);
    setLoadingMore(false);
    setLoading(true);

    void apiRequest<PublicMomentIndexResponse>(momentIndexApiPath(activeTag), {
      signal: controller.signal,
    }).then((response) => {
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      setItems(response.items);
      setNextCursor(response.nextCursor);
    }).catch((reason: unknown) => {
      if (generation === requestGeneration.current && requestFailed(reason, controller.signal)) {
        setInitialError(true);
      }
    }).finally(() => {
      if (generation === requestGeneration.current && !controller.signal.aborted) {
        initialController.current = null;
        setLoading(false);
      }
    });

    return () => {
      requestGeneration.current += 1;
      controller.abort();
      if (initialController.current === controller) initialController.current = null;
    };
  }, [activeTag, retryRevision]);

  useEffect(() => () => {
    initialController.current?.abort();
    pageController.current?.abort();
  }, []);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const cursor = nextCursor;
    const generation = requestGeneration.current;
    pageController.current?.abort();
    const controller = new AbortController();
    pageController.current = controller;
    setLoadingMore(true);
    setPageError(false);
    void apiRequest<PublicMomentIndexResponse>(momentIndexApiPath(activeTag, cursor), {
      signal: controller.signal,
    }).then((response) => {
      if (generation !== requestGeneration.current || controller.signal.aborted) return;
      setItems((current) => mergeMomentIndexItems(current, response.items));
      setNextCursor(response.nextCursor);
    }).catch((reason: unknown) => {
      if (generation === requestGeneration.current && requestFailed(reason, controller.signal)) {
        setPageError(true);
      }
    }).finally(() => {
      if (generation === requestGeneration.current && !controller.signal.aborted) {
        pageController.current = null;
        setLoadingMore(false);
      }
    });
  };

  const resetting = contentTag !== activeTag;
  const visibleItems = resetting ? [] : items;
  return (
    <main className="page-shell moments-index-page">
      <SectionHeading
        title={<span ref={headingRef} tabIndex={-1}>{text("精彩瞬间", "Highlights")}</span>}
        aside={<p>{text("关键牌局，逐手回放。", "Key hands, replayed hand by hand.")}</p>}
      />

      <nav className="moment-filter-nav" aria-label={text("筛选精彩瞬间", "Filter highlights")} ref={filterNavRef}>
        <div>
          {MOMENT_INDEX_FILTERS.map((filter) => {
            const active = activeTag === filter.tag;
            return (
              <Link
                className={active ? "active" : ""}
                to={momentIndexHref(filter.tag)}
                aria-current={active ? "page" : undefined}
                ref={active ? activeFilterRef : undefined}
                key={filter.tag ?? "ALL"}
              >
                {text(filter.zh, filter.en)}
              </Link>
            );
          })}
        </div>
      </nav>

      <section className="moments-index-results" aria-busy={loading || resetting || loadingMore}>
        {loading || resetting ? (
          <LoadingBlock label={text("正在编排精彩瞬间", "Loading highlights")} />
        ) : initialError ? (
          <ErrorBlock
            message={text("精彩瞬间暂时无法载入。", "Highlights could not be loaded.")}
            onRetry={() => setRetryRevision((current) => current + 1)}
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            title={text("暂无此类精彩瞬间", "No highlights in this cut")}
            body={text("可以切换分类，或从赛事档案查看完整牌局。", "Try another category or browse full matches in the archive.")}
            action={<Link className="button secondary" to="/tournaments">{text("查看赛事档案", "View tournament archive")}</Link>}
          />
        ) : (
          <>
            <div className="moments-index-feed">
              {visibleItems.map((item, index) => (
                <TournamentMomentCard
                  moment={item.moment}
                  lead={index === 0}
                  players={item.players}
                  tournament={item.tournament}
                  key={item.moment.id}
                />
              ))}
            </div>
            <footer className="moments-index-pagination">
              {pageError && <span role="alert">{text("下一页载入失败，可再次尝试。", "The next page failed to load. Try again.")}</span>}
              {nextCursor && (
                <button type="button" className="button secondary" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? text("载入中…", "Loading…") : pageError ? text("重试加载", "Try again") : text("加载更多", "Load more")}
                </button>
              )}
              {!nextCursor && !pageError && <span>{text("已呈现全部精彩瞬间", "All highlights shown")}</span>}
            </footer>
          </>
        )}
      </section>
    </main>
  );
}
