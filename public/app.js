(function () {
  'use strict';

  const MONTHS_TR = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'
  ];
  const DAYS_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

  let state = {
    meta: null,
    allMatches: [],
    selectedDayTab: 'TODAY', // 'TODAY' | 'TOMORROW' | 'OTHER'
    selectedLeague: 'ALL',
    selectedRisk: 'ALL',
    selectedMbs: 'ALL',
    onlyKingOdd: false,
    onlyLive: false,
    searchQuery: '',
    sortBy: 'time',
    visibleLimit: 60,
    coupon: []
  };

  function formatTurkishDate(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const dayName = DAYS_TR[d.getDay()];
    return `${Number(parts[2])} ${MONTHS_TR[Number(parts[1]) - 1]} ${parts[0]} ${dayName}`;
  }

  function formatOdd(val) {
    if (val === undefined || val === null || val === '') return '-';
    const num = Number(val);
    if (isNaN(num) || num <= 1.0) return '-';
    return num.toFixed(2);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Canlı zaman kontrolü: Sayfa açıkken de maç saati gelmişse başladığını otomatik algılar
  function isMatchStartedRuntime(m) {
    if (m.isLive || m.isStarted) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec >= m.timestamp;
  }

  function getRuntimeLiveStatus(m) {
    if (m.liveStatusText) return m.liveStatusText;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= m.timestamp) {
      const elapsedMin = Math.floor((nowSec - m.timestamp) / 60);
      if (elapsedMin >= 0 && elapsedMin <= 115) {
        if (elapsedMin >= 46 && elapsedMin <= 59) return 'Devre Arası';
        const gameMin = elapsedMin > 59 ? elapsedMin - 15 : Math.max(1, elapsedMin);
        return `Başladı • ${gameMin}'`;
      }
      return 'Tamamlandı';
    }
    return null;
  }

  let autoSyncCountdown = 60;
  let isSyncingNow = false;
  let openModalMatchId = null;

  async function triggerLiveSync(isManual = false) {
    if (isSyncingNow) return;
    isSyncingNow = true;
    const btnSyncNow = document.getElementById('btnSyncNow');
    const origText = '🔄 İddaa.com\'dan Oranları Güncelle';

    if (btnSyncNow) {
      btnSyncNow.innerHTML = isManual
        ? '⏳ iddaa.com Canlı Oranlar Çekiliyor...'
        : '🔄 Otomatik Yenileniyor...';
      btnSyncNow.disabled = true;
    }

    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      if (res.ok) {
        const freshRes = await fetch('/matches_data.json?t=' + Date.now());
        const freshData = await freshRes.json();
        applyDataset(freshData);
      } else {
        const freshRes = await fetch('/matches_data.json?t=' + Date.now());
        if (freshRes.ok) {
          const freshData = await freshRes.json();
          applyDataset(freshData);
        }
      }
      if (btnSyncNow) {
        btnSyncNow.innerHTML = '✅ Skorlar & Oranlar Güncellendi!';
      }
    } catch (err) {
      // Sunucu kapalıysa (file:// modunda) mevcut maçların canlı dakika durumlarını yenile
      renderMatches();
    } finally {
      autoSyncCountdown = 60;
      updateSyncStatusText();
      setTimeout(() => {
        if (btnSyncNow) {
          btnSyncNow.innerHTML = origText;
          btnSyncNow.disabled = false;
        }
        isSyncingNow = false;
      }, 1500);
    }
  }

  function updateSyncStatusText() {
    const syncEl = document.getElementById('syncText');
    if (!syncEl || !state.meta) return;
    const dt = state.meta.generatedAt ? new Date(state.meta.generatedAt) : new Date();
    const timeStr = dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const liveCnt = state.allMatches.filter((m) => isMatchStartedRuntime(m)).length;
    syncEl.textContent = `iddaa.com: ${state.allMatches.length} Maç (${liveCnt} Canlı) • Son: ${timeStr} • Oto Yenileme: ${autoSyncCountdown}sn`;
  }

  async function initApp() {
    if (window.IDDAA_DATA && window.IDDAA_DATA.matches) {
      applyDataset(window.IDDAA_DATA);
    } else {
      try {
        const res = await fetch('/api/matches');
        const data = await res.json();
        applyDataset(data);
      } catch (err) {
        console.error('Veri yüklenemedi:', err);
      }
    }
    bindEvents();

    // Her 1 saniyede geri sayımı güncelle, 60 saniyede (1 dakikada) bir otomatik olarak iddaa.com'dan yenile
    setInterval(() => {
      if (isSyncingNow) return;
      autoSyncCountdown -= 1;
      if (autoSyncCountdown <= 0) {
        triggerLiveSync(false);
      } else {
        updateSyncStatusText();
        // Her 15 saniyede bir ekran üzerindeki canlı dakika/başlama rozetlerini de tazele
        if (autoSyncCountdown % 15 === 0) {
          renderMatches();
        }
      }
    }, 1000);
  }

  function applyDataset(data) {
    state.meta = data.meta || {};
    // Yalnızca Futbol (sportId === 1)
    state.allMatches = (data.matches || []).filter((m) => m.sportId === 1);

    updateSyncStatusText();

    renderDayTabs();
    populateLeagueOptions();
    renderAICombos();
    renderMatches();
    renderCoupon();

    // Eğer açık bir maç detay modalı varsa onun içindeki oranları da canlı güncelle
    const modal = document.getElementById('matchModal');
    if (openModalMatchId && modal && modal.classList.contains('open')) {
      openMatchModal(openModalMatchId);
    }
  }

  function getMatchesForDayMode(dayMode) {
    const todayDate = state.meta.todayDate;
    const tomorrowDate = state.meta.tomorrowDate;

    return state.allMatches.filter((m) => {
      if (dayMode === 'TODAY') return m.date === todayDate;
      if (dayMode === 'TOMORROW') return m.date === tomorrowDate;
      if (dayMode === 'OTHER') return m.date !== todayDate && m.date !== tomorrowDate;
      return true;
    });
  }

  function renderDayTabs() {
    const wrapper = document.getElementById('dayTabsWrapper');
    if (!wrapper || !state.meta) return;

    const todayDate = state.meta.todayDate;
    const tomorrowDate = state.meta.tomorrowDate;
    const todayMatches = getMatchesForDayMode('TODAY');
    const tomorrowMatches = getMatchesForDayMode('TOMORROW');
    const otherMatches = getMatchesForDayMode('OTHER');

    const todayLiveCount = todayMatches.filter((m) => isMatchStartedRuntime(m)).length;

    wrapper.innerHTML = `
      <button type="button" class="day-tab ${state.selectedDayTab === 'TODAY' ? 'active' : ''}" data-day="TODAY">
        <div class="day-tab-info">
          <span class="day-badge">⚽ BUGÜNÜN FUTBOL MAÇLARI VE TAHMİNLERİ ${todayLiveCount > 0 ? `• 🔴 ${todayLiveCount} CANLI` : ''}</span>
          <span class="day-title">Bugün (${escapeHtml(formatTurkishDate(todayDate))})</span>
          <span class="day-subtitle">Günün tüm iddaa.com futbol maçları, canlı skorları, oranları ve AI tahminleri</span>
        </div>
        <div class="day-count-box">
          <span class="day-count-num">${todayMatches.length}</span>
          <span class="day-count-label">Futbol Maçı</span>
        </div>
      </button>

      <button type="button" class="day-tab ${state.selectedDayTab === 'TOMORROW' ? 'active' : ''}" data-day="TOMORROW">
        <div class="day-tab-info">
          <span class="day-badge">📆 SONRAKİ GÜNÜN (YARIN) FUTBOL TAHMİNLERİ</span>
          <span class="day-title">Yarın (${escapeHtml(formatTurkishDate(tomorrowDate))})</span>
          <span class="day-subtitle">Sonraki günün tüm iddaa.com futbol bülteni, güncel oranları ve AI analizleri</span>
        </div>
        <div class="day-count-box">
          <span class="day-count-num">${tomorrowMatches.length}</span>
          <span class="day-count-label">Futbol Maçı</span>
        </div>
      </button>

      <button type="button" class="day-tab day-tab-compact ${state.selectedDayTab === 'OTHER' ? 'active' : ''}" data-day="OTHER">
        <div class="day-tab-info">
          <span class="day-badge">🗓️ İLERİKİ GÜNLER</span>
          <span class="day-title">Diğer Günler</span>
          <span class="day-subtitle">Bültendeki diğer futbol maçları</span>
        </div>
        <div class="day-count-box">
          <span class="day-count-num">${otherMatches.length}</span>
          <span class="day-count-label">Futbol Maçı</span>
        </div>
      </button>
    `;

    wrapper.querySelectorAll('.day-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedDayTab = btn.getAttribute('data-day');
        state.selectedLeague = 'ALL';
        state.visibleLimit = 60;
        renderDayTabs();
        populateLeagueOptions();
        renderAICombos();
        renderMatches();
      });
    });
  }

  function populateLeagueOptions() {
    const select = document.getElementById('leagueSelect');
    if (!select) return;

    const pool = getMatchesForDayMode(state.selectedDayTab);
    const leagueMap = {};
    pool.forEach((m) => {
      if (!leagueMap[m.competitionId]) {
        leagueMap[m.competitionId] = {
          id: m.competitionId,
          name: m.competitionName,
          priority: m.competitionPriority || 9999,
          count: 0
        };
      }
      leagueMap[m.competitionId].count += 1;
    });

    const leagues = Object.values(leagueMap).sort((a, b) => a.priority - b.priority || b.count - a.count);

    let html = `<option value="ALL">Tüm Futbol Ligleri (${leagues.length} Lig)</option>`;
    leagues.forEach((lg) => {
      const sel = String(state.selectedLeague) === String(lg.id) ? 'selected' : '';
      html += `<option value="${lg.id}" ${sel}>${escapeHtml(lg.name)} (${lg.count})</option>`;
    });
    select.innerHTML = html;
  }

  function renderAICombos() {
    const container = document.getElementById('aiCombosSection');
    if (!container) return;

    const dayMatches = getMatchesForDayMode(state.selectedDayTab).filter(
      (m) => m.prediction && m.prediction.primaryOdd && Number(m.prediction.primaryOdd) >= 1.18
    );

    if (dayMatches.length < 2) {
      container.innerHTML = '';
      return;
    }

    const bankoMatches = [...dayMatches]
      .filter((m) => m.prediction.primaryOdd >= 1.20 && m.prediction.primaryOdd <= 1.65)
      .sort((a, b) => b.prediction.confidence - a.prediction.confidence || (b.playedPercentage || 0) - (a.playedPercentage || 0))
      .slice(0, 3);

    const idealMatches = [...dayMatches]
      .filter((m) => m.prediction.primaryOdd >= 1.48 && m.prediction.primaryOdd <= 2.20 && !bankoMatches.includes(m))
      .sort((a, b) => (b.playedPercentage || 0) - (a.playedPercentage || 0) || b.prediction.confidence - a.prediction.confidence)
      .slice(0, 3);

    const goalMatches = [...dayMatches]
      .filter((m) => m.prediction.quickOdds && Number(m.prediction.quickOdds.ust) >= 1.32 && Number(m.prediction.quickOdds.ust) <= 2.05)
      .sort((a, b) => (b.prediction.probabilities.over || 0) - (a.prediction.probabilities.over || 0))
      .slice(0, 3);

    const dayLabel = state.selectedDayTab === 'TODAY' ? 'Günün' : (state.selectedDayTab === 'TOMORROW' ? 'Yarının' : 'Bültenin');

    const combos = [
      {
        title: `🛡️ ${dayLabel} AI Banko Futbol Kuponu`,
        items: bankoMatches.map((m) => ({
          matchId: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          time: m.time,
          date: m.date,
          pickLabel: m.prediction.primaryPick,
          odd: Number(m.prediction.primaryOdd),
          confidence: m.prediction.confidence
        }))
      },
      {
        title: `💎 ${dayLabel} İdeal Oran Kuponu`,
        items: idealMatches.map((m) => ({
          matchId: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          time: m.time,
          date: m.date,
          pickLabel: m.prediction.primaryPick,
          odd: Number(m.prediction.primaryOdd),
          confidence: m.prediction.confidence
        }))
      },
      {
        title: `⚽ ${dayLabel} Gol / Üst Kuponu`,
        items: goalMatches.map((m) => ({
          matchId: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          time: m.time,
          date: m.date,
          pickLabel: `${m.prediction.quickOdds.ouLine || '2.5'} Üst`,
          odd: Number(m.prediction.quickOdds.ust),
          confidence: Math.round(m.prediction.probabilities.over || 60)
        }))
      }
    ].filter((c) => c.items.length >= 2);

    container.innerHTML = combos.map((combo, idx) => {
      const totalOdd = combo.items.reduce((acc, it) => acc * it.odd, 1).toFixed(2);
      const picksHtml = combo.items.map((it) => `
        <div class="combo-pick-item">
          <span class="combo-pick-teams">${escapeHtml(it.homeTeam)} - ${escapeHtml(it.awayTeam)}</span>
          <span class="combo-pick-badge">${escapeHtml(it.pickLabel)} (${it.odd.toFixed(2)})</span>
        </div>
      `).join('');

      return `
        <div class="combo-card">
          <div>
            <div class="combo-header">
              <span class="combo-title">${combo.title}</span>
              <span class="combo-total-odd">Toplam Oran: ${totalOdd}</span>
            </div>
            <div class="combo-picks-list" style="margin-top: 8px;">
              ${picksHtml}
            </div>
          </div>
          <button type="button" class="combo-apply-btn" data-combo-idx="${idx}">
            ➕ Bu Kuponu Kuponuma Aktar (${combo.items.length} Maç)
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.combo-apply-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-combo-idx'));
        const chosen = combos[idx];
        if (!chosen) return;
        state.coupon = [...chosen.items];
        renderCoupon();
        renderMatches();
      });
    });
  }

  function getFilteredMatches() {
    let list = getMatchesForDayMode(state.selectedDayTab);

    if (state.selectedLeague !== 'ALL') {
      list = list.filter((m) => String(m.competitionId) === String(state.selectedLeague));
    }
    if (state.selectedRisk !== 'ALL') {
      list = list.filter((m) => m.prediction && m.prediction.riskLevel === state.selectedRisk);
    }
    if (state.selectedMbs !== 'ALL') {
      list = list.filter((m) => String(m.mbs) === String(state.selectedMbs));
    }
    if (state.onlyKingOdd) {
      list = list.filter((m) => m.kingOdd);
    }
    if (state.onlyLive) {
      list = list.filter((m) => isMatchStartedRuntime(m));
    }
    if (state.searchQuery.trim() !== '') {
      const q = state.searchQuery.toLocaleLowerCase('tr-TR').trim();
      list = list.filter((m) =>
        (m.homeTeam && m.homeTeam.toLocaleLowerCase('tr-TR').includes(q)) ||
        (m.awayTeam && m.awayTeam.toLocaleLowerCase('tr-TR').includes(q)) ||
        (m.competitionName && m.competitionName.toLocaleLowerCase('tr-TR').includes(q))
      );
    }

    list = [...list];
    if (state.sortBy === 'confidence') {
      list.sort((a, b) => (b.prediction?.confidence || 0) - (a.prediction?.confidence || 0) || a.timestamp - b.timestamp);
    } else if (state.sortBy === 'popular') {
      list.sort((a, b) => (b.playedPercentage || 0) - (a.playedPercentage || 0) || a.timestamp - b.timestamp);
    } else if (state.sortBy === 'priority') {
      list.sort((a, b) => (a.competitionPriority || 9999) - (b.competitionPriority || 9999) || a.timestamp - b.timestamp);
    } else {
      list.sort((a, b) => a.timestamp - b.timestamp || (a.competitionPriority || 9999) - (b.competitionPriority || 9999));
    }

    return list;
  }

  function isPickInCoupon(matchId, pickLabel) {
    return state.coupon.some((c) => c.matchId === matchId && c.pickLabel === pickLabel);
  }

  function renderMatches() {
    const listContainer = document.getElementById('matchesList');
    const countEl = document.getElementById('resultsCountText');
    const activeDateEl = document.getElementById('activeDateLabel');
    const loadMoreWrap = document.getElementById('loadMoreWrap');
    const remainingCountEl = document.getElementById('remainingCount');

    const filtered = getFilteredMatches();

    if (activeDateEl && state.meta) {
      if (state.selectedDayTab === 'TODAY') {
        activeDateEl.textContent = `📅 Bugün (${formatTurkishDate(state.meta.todayDate)})`;
      } else if (state.selectedDayTab === 'TOMORROW') {
        activeDateEl.textContent = `📆 Sonraki Gün / Yarın (${formatTurkishDate(state.meta.tomorrowDate)})`;
      } else {
        activeDateEl.textContent = `🗓️ İleriki Günler Futbol Bülteni`;
      }
    }

    if (countEl) {
      const liveCnt = filtered.filter((m) => isMatchStartedRuntime(m)).length;
      countEl.innerHTML = `Gösterilen: <strong>${Math.min(filtered.length, state.visibleLimit)}</strong> / Toplam <strong>${filtered.length}</strong> futbol maçı ${liveCnt > 0 ? `(🔴 <strong>${liveCnt}</strong> maç şu an canlı/başlamış)` : ''}`;
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <div class="match-card" style="text-align: center; padding: 40px 20px;">
          <p style="font-size: 32px; margin-bottom: 10px;">⚽</p>
          <h3 style="font-size: 16px;">Arama veya filtre kriterlerinize uygun futbol maçı bulunamadı.</h3>
          <p style="color: var(--text-secondary); font-size: 13px; margin-top: 6px;">Filtreleri sıfırlayarak iddaa.com futbol bültenindeki tüm maçları görebilirsiniz.</p>
        </div>
      `;
      loadMoreWrap.style.display = 'none';
      return;
    }

    const visibleMatches = filtered.slice(0, state.visibleLimit);
    listContainer.innerHTML = visibleMatches.map((m) => buildMatchCardHtml(m)).join('');

    if (filtered.length > state.visibleLimit) {
      loadMoreWrap.style.display = 'block';
      remainingCountEl.textContent = filtered.length - state.visibleLimit;
    } else {
      loadMoreWrap.style.display = 'none';
    }

    listContainer.querySelectorAll('.odd-btn:not(.disabled)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const matchId = Number(btn.getAttribute('data-match-id'));
        const pickLabel = btn.getAttribute('data-pick-label');
        const oddVal = Number(btn.getAttribute('data-odd'));
        toggleCouponItem(matchId, pickLabel, oddVal);
      });
    });

    listContainer.querySelectorAll('.all-markets-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const matchId = Number(btn.getAttribute('data-match-id'));
        openMatchModal(matchId);
      });
    });
  }

  function buildMatchCardHtml(m) {
    const pred = m.prediction || {};
    const q = pred.quickOdds || {};
    const riskClass = pred.riskLevel === 'Banko' ? 'risk-banko' : (pred.riskLevel === 'İdeal' ? 'risk-ideal' : 'risk-surpriz');

    const started = isMatchStartedRuntime(m);
    const liveStatus = getRuntimeLiveStatus(m);
    const hasScore = m.homeScore !== null && m.homeScore !== undefined && m.awayScore !== null && m.awayScore !== undefined;

    const altChips = (pred.alternativePicks || []).slice(0, 3).map((ap) => `
      <span class="alt-chip">${escapeHtml(ap.type)}: <strong>${escapeHtml(ap.pick)} (${formatOdd(ap.odd)})</strong></span>
    `).join('');

    const ouLine = q.ouLine || '2.5';

    // Oran Kutusu (iddaa.com tarzı Kral Oran üstü çizili eski oran wodd + kilit durumu destekli)
    const renderOddBtn = (label, pickKey, oddVal, woddVal, isLocked) => {
      const hasOdd = !isLocked && oddVal && Number(oddVal) > 1.0;
      const selected = hasOdd && isPickInCoupon(m.id, pickKey);
      const isAiRec = hasOdd && pred.primaryPick === pickKey;
      const hasWodd = hasOdd && woddVal && Number(woddVal) > 1.0 && Number(woddVal) !== Number(oddVal);

      return `
        <div class="odd-btn ${hasOdd ? '' : 'disabled'} ${selected ? 'selected' : ''} ${isAiRec ? 'ai-recommended' : ''}"
             data-match-id="${m.id}"
             data-pick-label="${escapeHtml(pickKey)}"
             data-odd="${hasOdd ? oddVal : 0}">
          <span class="odd-label">${escapeHtml(label)}</span>
          ${hasWodd ? `<span class="odd-wodd">${Number(woddVal).toFixed(2)}</span>` : ''}
          <span class="odd-val">${hasOdd ? Number(oddVal).toFixed(2) : '🔒'}</span>
        </div>
      `;
    };

    let kgOrCsHtml = '';
    if (q.kgVar || q.kgYok) {
      kgOrCsHtml = `
        <div class="odds-group">
          <div class="odds-group-title">Karşılıklı Gol</div>
          <div class="odds-buttons">
            ${renderOddBtn('KG Var', 'KG Var', q.kgVar, q.kgVarWodd, q.kgVarLocked)}
            ${renderOddBtn('KG Yok', 'KG Yok', q.kgYok, q.kgYokWodd, q.kgYokLocked)}
          </div>
        </div>
      `;
    } else if (q.cs10 || q.cs02) {
      kgOrCsHtml = `
        <div class="odds-group">
          <div class="odds-group-title">Çifte Şans</div>
          <div class="odds-buttons">
            ${renderOddBtn('1-0', 'ÇŞ 1-0', q.cs10, null, false)}
            ${renderOddBtn('1-2', 'ÇŞ 1-2', q.cs12, null, false)}
            ${renderOddBtn('0-2', 'ÇŞ 0-2', q.cs02, null, false)}
          </div>
        </div>
      `;
    }

    const homeRedHtml = m.homeRedCards > 0 ? `<span class="red-card-badge" title="Kırmızı Kart">🟥 ${m.homeRedCards}</span>` : '';
    const awayRedHtml = m.awayRedCards > 0 ? `<span class="red-card-badge" title="Kırmızı Kart">🟥 ${m.awayRedCards}</span>` : '';

    let liveStatsExtra = '';
    if (started) {
      const parts = [];
      if (m.htScore) parts.push(`İY: ${m.htScore}`);
      if (m.homeCorners !== null && m.homeCorners !== undefined && m.awayCorners !== null) {
        parts.push(`🚩 Korner: ${m.homeCorners}-${m.awayCorners}`);
      }
      if (parts.length > 0) {
        liveStatsExtra = `<span class="live-stats-pill">${escapeHtml(parts.join(' • '))}</span>`;
      }
    }

    return `
      <article class="match-card ${started ? 'live-match' : ''}">
        <div class="match-meta-row">
          <div class="match-league">
            <img src="${escapeHtml(m.competitionIcon)}" alt="" class="league-flag" onerror="this.style.display='none'" />
            <span>⚽ ${escapeHtml(m.competitionName)}</span>
          </div>

          <div class="match-badges">
            ${started ? `<span class="badge badge-live">🔴 ${escapeHtml(liveStatus || 'CANLI')}</span>` : ''}
            <span class="badge badge-time">🕒 ${escapeHtml(m.time)} (${escapeHtml(m.date)})</span>
            <span class="badge badge-mbs">MBS ${m.mbs}</span>
            ${m.kingOdd ? '<span class="badge badge-king">👑 Kral Oran</span>' : ''}
            ${m.playedPercentage ? `<span class="badge badge-popular">🔥 %${m.playedPercentage} Oynanma</span>` : ''}
          </div>
        </div>

        <div class="match-main-grid">
          <!-- Teams, Live Score & AI Score Prediction -->
          <div class="teams-box">
            <div class="team-row">
              <span>🏠 ${escapeHtml(m.homeTeam)} ${homeRedHtml}</span>
              ${hasScore ? `<span class="team-score-badge">${m.homeScore}</span>` : ''}
            </div>
            <div class="vs-divider">
              <span>${started ? 'CANLI SKOR' : 'VS'}</span>
              ${liveStatsExtra}
              ${pred.predictedScore ? `<span class="predicted-score-pill">🤖 AI Skor Tahmini: ${escapeHtml(pred.predictedScore)}</span>` : ''}
            </div>
            <div class="team-row">
              <span>✈️ ${escapeHtml(m.awayTeam)} ${awayRedHtml}</span>
              ${hasScore ? `<span class="team-score-badge">${m.awayScore}</span>` : ''}
            </div>
          </div>

          <!-- AI Primary Prediction Box -->
          <div class="ai-prediction-box">
            <div class="ai-pred-top">
              <span class="ai-pred-label">🤖 YAPAY ZEKA TAHMİNİ</span>
              <span class="risk-badge ${riskClass}">${escapeHtml(pred.riskLevel || 'İdeal')}</span>
            </div>
            <div class="ai-pred-main">
              <span class="ai-pick-name">${escapeHtml(pred.primaryPick || 'Analiz')}</span>
              <span class="ai-pick-odd">${formatOdd(pred.primaryOdd)}</span>
            </div>
            <div class="confidence-bar-wrap">
              <div class="confidence-track">
                <div class="confidence-fill" style="width: ${pred.confidence || 60}%"></div>
              </div>
              <span class="confidence-pct">%${pred.confidence || 60} Güven</span>
            </div>
          </div>

          <!-- Official iddaa.com Odds -->
          <div class="quick-odds-container">
            <div class="odds-groups-row">
              <div class="odds-group">
                <div class="odds-group-title">Maç Sonucu (MS)</div>
                <div class="odds-buttons">
                  ${renderOddBtn('MS 1', 'MS 1', q.ms1, q.ms1Wodd, q.ms1Locked)}
                  ${renderOddBtn('MS 0', 'MS 0', q.ms0, q.ms0Wodd, q.ms0Locked)}
                  ${renderOddBtn('MS 2', 'MS 2', q.ms2, q.ms2Wodd, q.ms2Locked)}
                </div>
              </div>

              <div class="odds-group">
                <div class="odds-group-title">${escapeHtml(ouLine)} Alt / Üst</div>
                <div class="odds-buttons">
                  ${renderOddBtn(`${ouLine} Alt`, `${ouLine} Alt`, q.alt, q.altWodd, q.altLocked)}
                  ${renderOddBtn(`${ouLine} Üst`, `${ouLine} Üst`, q.ust, q.ustWodd, q.ustLocked)}
                </div>
              </div>

              ${kgOrCsHtml}
            </div>
          </div>
        </div>

        <div class="match-footer">
          <div class="ai-reason-text">
            <span>💡</span>
            <span>${escapeHtml(pred.reasoning || '')}</span>
          </div>
          <div class="alt-picks-chips">
            ${altChips}
            <button type="button" class="all-markets-btn" data-match-id="${m.id}">
              +${m.marketsCount} Market &amp; Tüm Oranlar (${m.totalOddsCount})
            </button>
          </div>
        </div>
      </article>
    `;
  }

  function toggleCouponItem(matchId, pickLabel, oddVal) {
    const match = state.allMatches.find((m) => m.id === matchId);
    if (!match || !oddVal || oddVal <= 1.0) return;

    const existingIdx = state.coupon.findIndex((c) => c.matchId === matchId);
    if (existingIdx !== -1) {
      if (state.coupon[existingIdx].pickLabel === pickLabel) {
        state.coupon.splice(existingIdx, 1);
      } else {
        state.coupon[existingIdx].pickLabel = pickLabel;
        state.coupon[existingIdx].odd = oddVal;
      }
    } else {
      state.coupon.push({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        time: match.time,
        date: match.date,
        pickLabel: pickLabel,
        odd: oddVal,
        confidence: match.prediction ? match.prediction.confidence : 65
      });
    }

    renderCoupon();
    renderMatches();
  }

  function renderCoupon() {
    const badgeEl = document.getElementById('couponCountBadge');
    const emptyEl = document.getElementById('couponEmpty');
    const itemsEl = document.getElementById('couponItems');
    const summaryEl = document.getElementById('couponSummary');

    const count = state.coupon.length;
    if (badgeEl) badgeEl.textContent = `${count} Maç`;

    if (count === 0) {
      emptyEl.style.display = 'block';
      itemsEl.style.display = 'none';
      summaryEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    itemsEl.style.display = 'flex';
    summaryEl.style.display = 'flex';

    itemsEl.innerHTML = state.coupon.map((item) => `
      <div class="coupon-item">
        <div class="coupon-item-top">
          <span>${escapeHtml(item.homeTeam)} - ${escapeHtml(item.awayTeam)}</span>
        </div>
        <button type="button" class="coupon-remove-btn" data-remove-id="${item.matchId}">✕</button>
        <div class="coupon-item-bottom">
          <span>Tahmin: <strong style="color: #fff;">${escapeHtml(item.pickLabel)}</strong> (${escapeHtml(item.time)})</span>
          <span class="coupon-item-odd">${item.odd.toFixed(2)}</span>
        </div>
      </div>
    `).join('');

    itemsEl.querySelectorAll('.coupon-remove-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-remove-id'));
        state.coupon = state.coupon.filter((c) => c.matchId !== id);
        renderCoupon();
        renderMatches();
      });
    });

    const totalOdd = state.coupon.reduce((acc, it) => acc * it.odd, 1);
    const avgConf = Math.round(state.coupon.reduce((acc, it) => acc + (it.confidence || 65), 0) / count);
    const stake = Number(document.getElementById('stakeSelect')?.value || 50);
    const maxWin = totalOdd * stake;

    document.getElementById('sumMatchCount').textContent = String(count);
    document.getElementById('sumAvgConf').textContent = `%${avgConf}`;
    document.getElementById('sumTotalOdd').textContent = totalOdd.toFixed(2);
    document.getElementById('sumMaxWin').textContent = `${maxWin.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TL`;
  }

  function openMatchModal(matchId) {
    const match = state.allMatches.find((m) => m.id === matchId);
    if (!match) return;
    openModalMatchId = matchId;

    const modal = document.getElementById('matchModal');
    const leagueEl = document.getElementById('modalLeague');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');

    const started = isMatchStartedRuntime(match);
    const liveStatus = getRuntimeLiveStatus(match);
    const scoreStr = (match.homeScore !== null && match.homeScore !== undefined) ? ` (${match.homeScore} - ${match.awayScore})` : '';

    leagueEl.textContent = `⚽ ${match.competitionName} • ${formatTurkishDate(match.date)} Saat ${match.time} • MBS ${match.mbs} ${started ? `• 🔴 ${liveStatus}` : ''}`;
    titleEl.textContent = `${match.homeTeam}${scoreStr} vs ${match.awayTeam}`;

    const pred = match.prediction || {};
    const markets = match.markets || [];

    let marketsHtml = markets.map((mk) => {
      const outcomesHtml = (mk.outcomes || []).map((o) => {
        const pickKey = `${mk.name}: ${o.name}`;
        const hasOdd = !o.locked && o.odd && Number(o.odd) > 1.0;
        const selected = hasOdd && isPickInCoupon(match.id, pickKey);
        const hasWodd = hasOdd && o.wodd && Number(o.wodd) > 1.0 && Number(o.wodd) !== Number(o.odd);

        return `
          <div class="odd-btn ${hasOdd ? '' : 'disabled'} ${selected ? 'selected' : ''}"
               data-modal-match-id="${match.id}"
               data-modal-pick="${escapeHtml(pickKey)}"
               data-modal-odd="${hasOdd ? o.odd : 0}">
            <span class="odd-label">${escapeHtml(o.name)} ${o.playPct ? `(%${o.playPct})` : ''}</span>
            ${hasWodd ? `<span class="odd-wodd">${Number(o.wodd).toFixed(2)}</span>` : ''}
            <span class="odd-val">${hasOdd ? Number(o.odd).toFixed(2) : '🔒'}</span>
          </div>
        `;
      }).join('');

      return `
        <div class="market-block">
          <div class="market-block-header">
            <span>${escapeHtml(mk.name)}</span>
            <span style="font-size: 11px; color: var(--text-secondary);">MBS ${mk.mbc || match.mbs}</span>
          </div>
          <div class="market-outcomes-grid">
            ${outcomesHtml}
          </div>
        </div>
      `;
    }).join('');

    bodyEl.innerHTML = `
      <div class="ai-prediction-box" style="padding: 14px 16px;">
        <div class="ai-pred-top">
          <span class="ai-pred-label">🤖 DETAYLI YAPAY ZEKA FUTBOL ANALİZİ</span>
          <span class="risk-badge risk-banko">Güven: %${pred.confidence || 65}</span>
        </div>
        <div class="ai-pred-main" style="margin-top: 4px;">
          <span class="ai-pick-name">Ana Tahmin: ${escapeHtml(pred.primaryPick)} (${formatOdd(pred.primaryOdd)})</span>
          ${pred.predictedScore ? `<span class="predicted-score-pill">Beklenen Skor: ${escapeHtml(pred.predictedScore)}</span>` : ''}
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin-top: 6px;">${escapeHtml(pred.reasoning)}</p>
      </div>
      <h4 style="font-size: 14px; color: var(--text-secondary); margin-top: 4px;">İddaa.com Açık Futbol Marketleri (${markets.length} Market)</h4>
      ${marketsHtml}
    `;

    bodyEl.querySelectorAll('.odd-btn:not(.disabled)').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mId = Number(btn.getAttribute('data-modal-match-id'));
        const pk = btn.getAttribute('data-modal-pick');
        const od = Number(btn.getAttribute('data-modal-odd'));
        toggleCouponItem(mId, pk, od);
        openMatchModal(mId);
      });
    });

    modal.classList.add('open');
  }

  function bindEvents() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const leagueSelect = document.getElementById('leagueSelect');
    if (leagueSelect) {
      leagueSelect.addEventListener('change', (e) => {
        state.selectedLeague = e.target.value;
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const riskSelect = document.getElementById('riskSelect');
    if (riskSelect) {
      riskSelect.addEventListener('change', (e) => {
        state.selectedRisk = e.target.value;
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const mbsSelect = document.getElementById('mbsSelect');
    if (mbsSelect) {
      mbsSelect.addEventListener('change', (e) => {
        state.selectedMbs = e.target.value;
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        state.sortBy = e.target.value;
        renderMatches();
      });
    }

    const toggleKingBtn = document.getElementById('toggleKingBtn');
    if (toggleKingBtn) {
      toggleKingBtn.addEventListener('click', () => {
        state.onlyKingOdd = !state.onlyKingOdd;
        toggleKingBtn.classList.toggle('active', state.onlyKingOdd);
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const toggleLiveBtn = document.getElementById('toggleLiveBtn');
    if (toggleLiveBtn) {
      toggleLiveBtn.addEventListener('click', () => {
        state.onlyLive = !state.onlyLive;
        toggleLiveBtn.classList.toggle('active', state.onlyLive);
        state.visibleLimit = 60;
        renderMatches();
      });
    }

    const btnLoadMore = document.getElementById('btnLoadMore');
    if (btnLoadMore) {
      btnLoadMore.addEventListener('click', () => {
        state.visibleLimit += 80;
        renderMatches();
      });
    }

    const stakeSelect = document.getElementById('stakeSelect');
    if (stakeSelect) {
      stakeSelect.addEventListener('change', () => renderCoupon());
    }

    const btnClearCoupon = document.getElementById('btnClearCoupon');
    if (btnClearCoupon) {
      btnClearCoupon.addEventListener('click', () => {
        state.coupon = [];
        renderCoupon();
        renderMatches();
      });
    }

    const btnCopyCoupon = document.getElementById('btnCopyCoupon');
    if (btnCopyCoupon) {
      btnCopyCoupon.addEventListener('click', () => {
        if (state.coupon.length === 0) return;
        const totalOdd = state.coupon.reduce((acc, it) => acc * it.odd, 1).toFixed(2);
        const lines = state.coupon.map((c, i) => `${i + 1}. ${c.homeTeam} - ${c.awayTeam} | Tahmin: ${c.pickLabel} | Oran: ${c.odd.toFixed(2)}`);
        const text = `⚽ YAPAYİDDAA FUTBOL TAHMİN KUPONU\n` + lines.join('\n') + `\nToplam Oran: ${totalOdd}`;
        navigator.clipboard?.writeText(text);
        btnCopyCoupon.textContent = '✅ Kopyalandı!';
        setTimeout(() => {
          btnCopyCoupon.textContent = '📋 Kuponu Kopyala';
        }, 2000);
      });
    }

    const btnAutoCoupon = document.getElementById('btnAutoCoupon');
    if (btnAutoCoupon) {
      btnAutoCoupon.addEventListener('click', () => {
        const pool = getFilteredMatches().filter((m) => m.prediction && m.prediction.primaryOdd >= 1.22 && m.prediction.primaryOdd <= 2.15);
        const top4 = [...pool]
          .sort((a, b) => b.prediction.confidence - a.prediction.confidence || (b.playedPercentage || 0) - (a.playedPercentage || 0))
          .slice(0, 4);
        state.coupon = top4.map((m) => ({
          matchId: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          time: m.time,
          date: m.date,
          pickLabel: m.prediction.primaryPick,
          odd: Number(m.prediction.primaryOdd),
          confidence: m.prediction.confidence
        }));
        renderCoupon();
        renderMatches();
      });
    }

    const btnSyncNow = document.getElementById('btnSyncNow');
    if (btnSyncNow) {
      btnSyncNow.addEventListener('click', () => {
        triggerLiveSync(true);
      });
    }

    const modalCloseBtn = document.getElementById('modalCloseBtn');
    const matchModal = document.getElementById('matchModal');
    if (modalCloseBtn && matchModal) {
      modalCloseBtn.addEventListener('click', () => {
        matchModal.classList.remove('open');
        openModalMatchId = null;
      });
      matchModal.addEventListener('click', (e) => {
        if (e.target === matchModal) {
          matchModal.classList.remove('open');
          openModalMatchId = null;
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
