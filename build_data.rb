#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'time'
require 'net/http'
require 'uri'
require 'openssl'

DATA_DIR = File.expand_path('data', __dir__)
PUBLIC_DIR = File.expand_path('public', __dir__)

# Sadece Futbol (st=1)
SPORTS_CONFIG = {
  1 => { name: 'Futbol', slug: 'futbol', icon: '⚽', order: 1 }
}.freeze

# iddaa.com resmi maç durum kodları (sc[id]['s'])
STATUS_LABELS = {
  1 => 'Başlıyor',
  2 => '1. Yarı',
  3 => '2. Yarı',
  4 => 'Devre Arası',
  5 => 'Maç Sonu',
  6 => 'Maç Sonu',
  7 => 'Uzatma 1.Y',
  8 => 'Uzatma D.A',
  9 => 'Uzatma 2.Y',
  10 => 'Uzatma MS',
  11 => 'Penaltılar',
  12 => 'Penaltılar MS',
  13 => 'Ertelendi',
  14 => 'İptal',
  24 => 'Ertelendi',
  25 => 'Duraklatıldı',
  26 => 'İptal',
  34 => 'Canlı',
  49 => 'Devre Arası',
  60 => 'Uzatmalar',
  61 => 'Maç Sonu',
  63 => 'Kesildi',
  64 => 'Başlamak Üzere',
  67 => 'Askıya Alındı',
  134 => 'Devre Arası',
  135 => 'Devre Arası',
  136 => 'Devre Arası',
  137 => 'Devre Arası'
}.freeze

def fetch_url(url)
  uri = URI.parse(url)
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = (uri.scheme == 'https')
  http.verify_mode = OpenSSL::SSL::VERIFY_NONE
  http.open_timeout = 8
  http.read_timeout = 12
  req = Net::HTTP::Get.new(uri.request_uri)
  req['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
  req['Accept'] = 'application/json, text/plain, */*'
  req['Origin'] = 'https://www.iddaa.com'
  req['Referer'] = 'https://www.iddaa.com/program/futbol'
  res = http.request(req)
  return res.body if res.code.to_i == 200
  nil
rescue StandardError => e
  warn "Fetch error for #{url}: #{e.message}"
  nil
end

def sync_from_iddaa!
  puts "🔄 iddaa.com futbol bülteni, canlı skorlar ve oranlar güncelleniyor..."
  endpoints = {
    'events_1.json' => 'https://sportsbookv2.iddaa.com/sportsbook/events?st=1&type=0&version=0&live=true',
    'outcome_percentages_1.json' => 'https://sportsbookv2.iddaa.com/sportsbook/outcome-play-percentages?sportType=1',
    'played_percentages_1.json' => 'https://sportsbookv2.iddaa.com/sportsbook/played-event-percentage?sportType=1',
    'competitions.json' => 'https://sportsbookv2.iddaa.com/sportsbook/competitions',
    'market_config.json' => 'https://sportsbookv2.iddaa.com/sportsbook/get_market_config'
  }

  updated = 0
  endpoints.each do |filename, url|
    body = fetch_url(url)
    if body && body.include?('"isSuccess":true')
      File.write(File.join(DATA_DIR, filename), body)
      updated += 1
    end
  end
  puts "✅ #{updated}/#{endpoints.size} veri kaynağı iddaa.com'dan güncellendi."
  updated > 0
end

def load_json(filename)
  path = File.join(DATA_DIR, filename)
  return nil unless File.exist?(path)
  JSON.parse(File.read(path))
rescue StandardError => e
  warn "JSON parse error in #{filename}: #{e.message}"
  nil
end

def format_market_name(template, sov)
  return 'Bahis' unless template
  name = template.dup.gsub(/\s+/, ' ')
  if sov && !sov.to_s.empty?
    parts = sov.to_s.split(',')
    parts.each_with_index do |p, idx|
      name.gsub!("{#{idx}}", p)
    end
    name.gsub!('{h}', sov.to_s)
    name.gsub!('{0}', sov.to_s)
  else
    name.gsub!(/\{[0-9h]\}/, '')
  end
  name.strip
end

# Market bulucu: tam kod (örn. '1_1' veya '2_101') ve tam sov (örn. '2.5') eşleşmesi yapar
def find_market(markets, keys, sov_filter = :any)
  markets.find do |m|
    key = "#{m['t']}_#{m['st']}"
    next false unless keys.include?(key)
    next false unless m['o'] && !m['o'].empty?

    if sov_filter == :any
      true
    elsif sov_filter.nil?
      m['sov'].nil? || m['sov'].to_s.empty?
    else
      m['sov'].to_s == sov_filter.to_s
    end
  end
end

# Outcome içinden isim veya sıra numarasına göre güvenli oran çekici
def extract_outcome(market, outcome_name, fallback_no = nil)
  return nil unless market && market['o']
  item = market['o'].find { |o| o['n'].to_s.strip.casecmp(outcome_name.to_s.strip).zero? }
  item ||= market['o'].find { |o| o['no'] == fallback_no } if fallback_no
  return nil unless item

  odd_val = item['odd'].to_f
  wodd_val = item['wodd'].to_f
  # iddaa.com'da odd == 1.0 (veya <= 1.0) o tercihin bahse kapalı / kilitli olduğu anlamına gelir
  is_locked = (market['s'] && market['s'] != 1) || odd_val <= 1.0

  {
    odd: odd_val > 1.0 ? odd_val : nil,
    wodd: (wodd_val > 1.0 && wodd_val != odd_val) ? wodd_val : nil,
    locked: is_locked
  }
end

def implied_probabilities(outcomes)
  return {} unless outcomes
  valid = outcomes.select { |o| o['odd'].to_f > 1.0 }
  return {} if valid.empty?
  inv_sum = valid.sum { |o| 1.0 / o['odd'].to_f }
  return {} if inv_sum <= 0
  probs = {}
  outcomes.each do |o|
    odd = o['odd'].to_f
    probs[o['n']] = odd > 1.0 ? ((1.0 / odd) / inv_sum * 100.0).round(1) : 0.0
  end
  probs
end

def extract_live_state(ev, sc_map, now_ts)
  ev_id = ev['i'].to_s
  sc = sc_map[ev_id]
  kickoff_ts = ev['d'].to_i
  bp_live = (ev['bp'].to_i == 1)
  time_started = (now_ts >= kickoff_ts)

  is_started = bp_live || !sc.nil? || time_started
  is_finished = false
  status_text = nil
  minute = nil
  home_score = nil
  away_score = nil
  ht_home_score = nil
  ht_away_score = nil
  home_red = 0
  away_red = 0
  home_corners = nil
  away_corners = nil

  if sc
    status_code = sc['s'].to_i
    minute = sc['min']
    home_score = sc.dig('ht', 'c') || sc.dig('ht', 'r') || 0
    away_score = sc.dig('at', 'c') || sc.dig('at', 'r') || 0
    ht_home_score = sc.dig('ht', 'ht')
    ht_away_score = sc.dig('at', 'ht')
    home_red = sc.dig('ht', 'rc').to_i
    away_red = sc.dig('at', 'rc').to_i
    home_corners = sc.dig('ht', 'co')
    away_corners = sc.dig('at', 'co')

    base_label = STATUS_LABELS[status_code] || 'Canlı'
    is_finished = [5, 6, 10, 12, 61].include?(status_code)

    status_text = if [4, 49, 134, 135, 136, 137].include?(status_code)
                    'Devre Arası'
                  elsif is_finished
                    'Maç Sonu'
                  elsif minute && minute.to_i > 0
                    "#{base_label} • #{minute}'"
                  else
                    base_label
                  end
  elsif bp_live
    status_text = 'Canlı • Başladı'
  elsif time_started
    elapsed_min = ((now_ts - kickoff_ts) / 60.0).floor
    if elapsed_min >= 0 && elapsed_min <= 115
      approx_min = elapsed_min > 45 && elapsed_min < 60 ? 'Devre Arası' : "#{[elapsed_min, 1].max}'"
      status_text = "Başladı (#{approx_min})"
    elsif elapsed_min > 115
      is_finished = true
      status_text = 'Tamamlandı'
    end
  end

  {
    isLive: bp_live || !sc.nil? || (time_started && !is_finished),
    isStarted: is_started,
    isFinished: is_finished,
    statusText: status_text,
    minute: minute,
    homeScore: home_score,
    awayScore: away_score,
    htScore: (ht_home_score && ht_away_score) ? "#{ht_home_score}-#{ht_away_score}" : nil,
    homeRedCards: home_red,
    awayRedCards: away_red,
    homeCorners: home_corners,
    awayCorners: away_corners
  }
end

def build_prediction(event, live_state, market_config, outcome_pcts, played_pct)
  markets = event['m'] || []
  hn = event['hn']
  an = event['an']

  # 1. Maç Sonucu (MS 1 / 0 / 2) -> Maç Önü: 1_1, Canlı: 4_4
  ms_market = find_market(markets, ['1_1', '4_4'], nil) || find_market(markets, ['1_1', '4_4'], :any)
  # 2. Alt/Üst 2.5 -> Maç Önü: 2_101 (sov="2.5"), Canlı: 4_14 (sov="2.5")
  ou25_market = find_market(markets, ['2_101', '4_14'], '2.5')
  # 3. Alt/Üst 1.5 & 3.5
  ou15_market = find_market(markets, ['2_101', '4_14'], '1.5')
  ou35_market = find_market(markets, ['2_101', '4_14'], '3.5')
  # 4. Karşılıklı Gol (KG Var / Yok) -> Maç Önü: 2_89, Canlı: 4_131
  kg_market = find_market(markets, ['2_89', '4_131'], nil) || find_market(markets, ['2_89', '4_131'], :any)
  # 5. Çifte Şans -> Maç Önü: 2_92, Canlı: 4_129
  cs_market = find_market(markets, ['2_92', '4_129'], nil) || find_market(markets, ['2_92', '4_129'], :any)
  # 6. 1. Yarı Sonucu -> Maç Önü: 2_88, Canlı: 4_47
  iy_market = find_market(markets, ['2_88', '4_47'], nil) || find_market(markets, ['2_88', '4_47'], :any)
  # 7. 1. Yarı 1.5 Alt/Üst -> Maç Önü: 2_60 (sov="1.5"), Canlı: 4_63 (sov="1.5")
  iy_ou15_market = find_market(markets, ['2_60', '4_63'], '1.5')
  # 8. Handikaplı Maç Sonucu -> Maç Önü: 2_100, Canlı: 4_12
  hms_market = find_market(markets, ['2_100', '4_12'], :any)

  # Eğer maçta 2.5 Alt/Üst yoksa ama başka bir ana barem (örn. 3.5 veya 1.5) açıksa onu yedek olarak tut
  primary_ou_market = ou25_market || ou35_market || ou15_market
  ou_line = primary_ou_market ? (primary_ou_market['sov'] || '2.5') : '2.5'

  ms1_obj = extract_outcome(ms_market, '1', 1)
  ms0_obj = extract_outcome(ms_market, '0', 2)
  ms2_obj = extract_outcome(ms_market, '2', 3)

  alt25_obj = extract_outcome(ou25_market, 'Alt', 1)
  ust25_obj = extract_outcome(ou25_market, 'Üst', 2)

  alt_main_obj = extract_outcome(primary_ou_market, 'Alt', 1)
  ust_main_obj = extract_outcome(primary_ou_market, 'Üst', 2)

  kg_var_obj = extract_outcome(kg_market, 'Var', 1)
  kg_yok_obj = extract_outcome(kg_market, 'Yok', 2)

  cs10_obj = extract_outcome(cs_market, '1 ve 0', 1)
  cs12_obj = extract_outcome(cs_market, '1 ve 2', 2)
  cs02_obj = extract_outcome(cs_market, '0 ve 2', 3)

  iy1_obj = extract_outcome(iy_market, '1', 1)
  iy0_obj = extract_outcome(iy_market, '0', 2)
  iy2_obj = extract_outcome(iy_market, '2', 3)

  ms_probs = ms_market ? implied_probabilities(ms_market['o']) : {}
  ou_probs = primary_ou_market ? implied_probabilities(primary_ou_market['o']) : {}
  kg_probs = kg_market ? implied_probabilities(kg_market['o']) : {}

  picks = []

  # 1. Maç Sonucu Analizi
  if ms1_obj&.dig(:odd) || ms2_obj&.dig(:odd) || ms0_obj&.dig(:odd)
    o1 = ms1_obj&.dig(:odd).to_f
    o0 = ms0_obj&.dig(:odd).to_f
    o2 = ms2_obj&.dig(:odd).to_f
    p1 = ms_probs['1'].to_f
    p0 = ms_probs['0'].to_f
    p2 = ms_probs['2'].to_f

    if p1 >= p2 && p1 >= p0 && o1 > 1.01
      picks << {
        type: 'Maç Sonucu',
        pick: 'MS 1',
        odd: o1,
        wodd: ms1_obj[:wodd],
        prob: p1,
        desc: "#{hn} kazanır (%#{p1.round} olasılık)"
      }
    elsif p2 > p1 && p2 >= p0 && o2 > 1.01
      picks << {
        type: 'Maç Sonucu',
        pick: 'MS 2',
        odd: o2,
        wodd: ms2_obj[:wodd],
        prob: p2,
        desc: "#{an} kazanır (%#{p2.round} olasılık)"
      }
    elsif o0 > 1.01
      picks << {
        type: 'Maç Sonucu',
        pick: 'MS 0',
        odd: o0,
        wodd: ms0_obj[:wodd],
        prob: p0,
        desc: "Beraberlik (%#{p0.round} olasılık)"
      }
    end

    # Dengeli maçlarda Çifte Şans
    if (p1 - p2).abs < 15.0
      if p1 >= p2 && cs10_obj&.dig(:odd).to_f > 1.15
        picks << {
          type: 'Çifte Şans',
          pick: 'ÇŞ 1-0',
          odd: cs10_obj[:odd],
          wodd: cs10_obj[:wodd],
          prob: (p1 + p0).round(1),
          desc: "#{hn} kaybetmez (%#{(p1 + p0).round} olasılık)"
        }
      elsif p2 > p1 && cs02_obj&.dig(:odd).to_f > 1.15
        picks << {
          type: 'Çifte Şans',
          pick: 'ÇŞ 0-2',
          odd: cs02_obj[:odd],
          wodd: cs02_obj[:wodd],
          prob: (p2 + p0).round(1),
          desc: "#{an} kaybetmez (%#{(p2 + p0).round} olasılık)"
        }
      end
    end
  end

  # 2. Alt / Üst Analizi
  if ust_main_obj&.dig(:odd) || alt_main_obj&.dig(:odd)
    o_ust = ust_main_obj&.dig(:odd).to_f
    o_alt = alt_main_obj&.dig(:odd).to_f
    p_ust = ou_probs['Üst'].to_f
    p_alt = ou_probs['Alt'].to_f

    if p_ust >= p_alt && o_ust > 1.05
      picks << {
        type: "#{ou_line} Alt/Üst",
        pick: "#{ou_line} Üst",
        odd: o_ust,
        wodd: ust_main_obj[:wodd],
        prob: p_ust,
        desc: "Toplam #{ou_line} Üst (%#{p_ust.round} olasılık)"
      }
    elsif o_alt > 1.05
      picks << {
        type: "#{ou_line} Alt/Üst",
        pick: "#{ou_line} Alt",
        odd: o_alt,
        wodd: alt_main_obj[:wodd],
        prob: p_alt,
        desc: "Toplam #{ou_line} Alt (%#{p_alt.round} olasılık)"
      }
    end
  end

  # 3. Karşılıklı Gol Analizi
  if kg_var_obj&.dig(:odd) || kg_yok_obj&.dig(:odd)
    o_var = kg_var_obj&.dig(:odd).to_f
    o_yok = kg_yok_obj&.dig(:odd).to_f
    p_var = kg_probs['Var'].to_f
    p_yok = kg_probs['Yok'].to_f

    if p_var >= p_yok && o_var > 1.05
      picks << {
        type: 'Karşılıklı Gol',
        pick: 'KG Var',
        odd: o_var,
        wodd: kg_var_obj[:wodd],
        prob: p_var,
        desc: "Karşılıklı Gol Var (%#{p_var.round} olasılık)"
      }
    elsif o_yok > 1.05
      picks << {
        type: 'Karşılıklı Gol',
        pick: 'KG Yok',
        odd: o_yok,
        wodd: kg_yok_obj[:wodd],
        prob: p_yok,
        desc: "Karşılıklı Gol Yok (%#{p_yok.round} olasılık)"
      }
    end
  end

  # Fallback: eğer canlı maçta ana marketler kilitliyse açık olan ilk marketten öneri üret
  if picks.empty? && markets.any?
    open_m = markets.find { |m| m['s'] == 1 && m['o'] && m['o'].any? { |o| o['odd'].to_f > 1.05 } }
    if open_m
      m_probs = implied_probabilities(open_m['o'])
      best_o = open_m['o'].select { |o| o['odd'].to_f > 1.05 }.min_by { |o| o['odd'].to_f }
      if best_o
        k = "#{open_m['t']}_#{open_m['st']}"
        m_name = format_market_name(market_config.dig(k, 'n'), open_m['sov'])
        pr = m_probs[best_o['n']] || 60.0
        picks << {
          type: m_name,
          pick: "#{m_name}: #{best_o['n']}",
          odd: best_o['odd'].to_f,
          wodd: best_o['wodd'].to_f > 1.0 ? best_o['wodd'].to_f : nil,
          prob: pr,
          desc: "#{m_name} - #{best_o['n']} (%#{pr.round} olasılık)"
        }
      end
    end
  end

  playable = picks.select { |pk| pk[:odd] >= 1.18 && pk[:odd] <= 2.65 }
  primary = playable.max_by { |pk| pk[:prob] * (pk[:odd] >= 1.28 ? 1.08 : 0.95) } || picks.max_by { |pk| pk[:prob] } || {
    type: 'Canlı Analiz',
    pick: 'Oranlar Kilitli',
    odd: 1.00,
    wodd: nil,
    prob: 50.0,
    desc: 'Canlı oran güncellemesi bekleniyor'
  }

  conf = [[primary[:prob].to_f.round, 52].max, 95].min
  risk_level = if conf >= 70 || (primary[:odd] > 1.0 && primary[:odd] <= 1.48)
                 'Banko'
               elsif conf >= 57 || primary[:odd] <= 1.88
                 'İdeal'
               else
                 'Sürpriz / Değerli'
               end

  # Skor Tahmini (Canlıysa mevcut skoru da hesaba katar)
  predicted_score = nil
  if ms_probs.any? || live_state[:homeScore]
    p1 = (ms_probs['1'] || 36.0) / 100.0
    p0 = (ms_probs['0'] || 28.0) / 100.0
    p2 = (ms_probs['2'] || 36.0) / 100.0
    p_ust = (ou_probs['Üst'] || 50.0) / 100.0
    p_var = (kg_probs['Var'] || 50.0) / 100.0

    total_xg = 1.65 + (p_ust * 1.85)
    home_share = (p1 + 0.5 * p0)
    away_share = (p2 + 0.5 * p0)
    norm = home_share + away_share
    hg = (total_xg * (home_share / norm)).round
    ag = (total_xg * (away_share / norm)).round

    if p_var > 0.55 && (hg == 0 || ag == 0)
      hg = [hg, 1].max
      ag = [ag, 1].max
    end
    if p1 - p2 > 0.18 && hg <= ag
      hg = ag + 1
    elsif p2 - p1 > 0.18 && ag <= hg
      ag = hg + 1
    elsif (p1 - p2).abs <= 0.08 && p0 >= 0.28
      hg = ag
    end

    # Eğer maç canlıysa ve mevcut skor tahminden yüksekse mevcut skora göre uyarla
    if live_state[:homeScore] && live_state[:awayScore]
      cur_h = live_state[:homeScore].to_i
      cur_a = live_state[:awayScore].to_i
      hg = [hg, cur_h].max
      ag = [ag, cur_a].max
    end

    predicted_score = "#{hg} - #{ag}"
  end

  reasons = []
  if live_state[:isLive] && live_state[:homeScore] && live_state[:awayScore]
    reasons << "🔴 CANLI (#{live_state[:statusText]}): Karşılaşmada anlık skor #{live_state[:homeScore]}-#{live_state[:awayScore]}."
  end

  if ms1_obj&.dig(:odd) && ms2_obj&.dig(:odd)
    p1 = ms_probs['1'].to_f
    p2 = ms_probs['2'].to_f
    if (p1 - p2).abs >= 24
      fav = p1 > p2 ? hn : an
      fav_odd = p1 > p2 ? ms1_obj[:odd] : ms2_obj[:odd]
      reasons << "İddaa oranlarına göre #{fav} (#{format('%.2f', fav_odd)}) net favori konumunda (%#{[p1, p2].max.round} olasılık)."
    elsif (p1 - p2).abs <= 10
      reasons << "Taraf oranları (#{format('%.2f', ms1_obj[:odd])} - #{format('%.2f', ms2_obj[:odd])}) iki takım arasında dengeli bir maç beklendiğini gösteriyor."
    else
      fav = p1 > p2 ? hn : an
      reasons << "Oran analizinde #{fav} bir adım önde."
    end
  end

  if ou25_market && ou_probs['Üst']
    if ou_probs['Üst'] >= 55 && ust25_obj&.dig(:odd)
      reasons << "2.5 Üst oranı (#{format('%.2f', ust25_obj[:odd])}) gollü bir mücadele (%#{ou_probs['Üst'].round}) beklentisini destekliyor."
    elsif ou_probs['Alt'] && ou_probs['Alt'] >= 55 && alt25_obj&.dig(:odd)
      reasons << "2.5 Alt oranı (#{format('%.2f', alt25_obj[:odd])}) kontrollü bir tempo (%#{ou_probs['Alt'].round}) ihtimalini öne çıkarıyor."
    end
  end

  if played_pct && played_pct > 0.5
    reasons << "İddaa bülteninde %#{played_pct} oynanma oranıyla popüler maçlar arasında."
  end

  if reasons.empty? && primary[:odd] > 1.0
    reasons << "Yapay zeka modelimiz #{primary[:pick]} (#{format('%.2f', primary[:odd])}) tercihini %#{conf} güvenle öneriyor."
  end

  {
    primaryPick: primary[:pick],
    primaryType: primary[:type],
    primaryOdd: primary[:odd] > 1.0 ? primary[:odd].round(2) : nil,
    primaryWodd: primary[:wodd],
    primaryDesc: primary[:desc],
    confidence: conf,
    riskLevel: risk_level,
    predictedScore: predicted_score,
    reasoning: reasons.join(' '),
    alternativePicks: picks.uniq { |x| x[:pick] }.first(4),
    probabilities: {
      ms1: ms_probs['1'],
      ms0: ms_probs['0'],
      ms2: ms_probs['2'],
      over: ou_probs['Üst'],
      under: ou_probs['Alt'],
      ouLine: ou_line,
      kgVar: kg_probs['Var'],
      kgYok: kg_probs['Yok']
    },
    quickOdds: {
      ms1: ms1_obj&.dig(:odd),
      ms1Wodd: ms1_obj&.dig(:wodd),
      ms1Locked: ms1_obj&.dig(:locked),
      ms0: ms0_obj&.dig(:odd),
      ms0Wodd: ms0_obj&.dig(:wodd),
      ms0Locked: ms0_obj&.dig(:locked),
      ms2: ms2_obj&.dig(:odd),
      ms2Wodd: ms2_obj&.dig(:wodd),
      ms2Locked: ms2_obj&.dig(:locked),
      ouLine: ou_line,
      alt: alt_main_obj&.dig(:odd),
      altWodd: alt_main_obj&.dig(:wodd),
      altLocked: alt_main_obj&.dig(:locked),
      ust: ust_main_obj&.dig(:odd),
      ustWodd: ust_main_obj&.dig(:wodd),
      ustLocked: ust_main_obj&.dig(:locked),
      kgVar: kg_var_obj&.dig(:odd),
      kgVarWodd: kg_var_obj&.dig(:wodd),
      kgVarLocked: kg_var_obj&.dig(:locked),
      kgYok: kg_yok_obj&.dig(:odd),
      kgYokWodd: kg_yok_obj&.dig(:wodd),
      kgYokLocked: kg_yok_obj&.dig(:locked),
      cs10: cs10_obj&.dig(:odd),
      cs12: cs12_obj&.dig(:odd),
      cs02: cs02_obj&.dig(:odd),
      iy1: iy1_obj&.dig(:odd),
      iy0: iy0_obj&.dig(:odd),
      iy2: iy2_obj&.dig(:odd)
    }
  }
end

def build_full_dataset!
  comp_raw = load_json('competitions.json')
  competitions = {}
  if comp_raw && comp_raw['data']
    comp_raw['data'].each do |c|
      competitions[c['i']] = {
        id: c['i'],
        name: c['n'],
        shortName: c['sn'] || c['n'],
        countryId: c['cid'],
        icon: c['ic'],
        priority: c['p'] || 9999
      }
    end
  end

  mc_raw = load_json('market_config.json')
  market_config = (mc_raw && mc_raw.dig('data', 'm')) || {}

  outcome_pcts_raw = load_json('outcome_percentages_1.json')
  outcome_pcts = (outcome_pcts_raw && outcome_pcts_raw['data']) || {}

  played_pcts_raw = load_json('played_percentages_1.json')
  played_pcts = (played_pcts_raw && played_pcts_raw['data']) || {}

  ev_raw = load_json('events_1.json')
  events = (ev_raw && ev_raw.dig('data', 'events')) || []
  sc_map = (ev_raw && ev_raw.dig('data', 'sc')) || {}

  now_ts = Time.now.to_i
  all_matches = []
  date_counts = Hash.new(0)
  live_count = 0

  events.each do |ev|
    sid = 1
    s_info = SPORTS_CONFIG[1]
    ts = ev['d'].to_i
    t_tr = Time.at(ts).getlocal('+03:00')
    date_key = t_tr.strftime('%Y-%m-%d')
    time_str = t_tr.strftime('%H:%M')

    comp = competitions[ev['ci']] || {
      id: ev['ci'],
      name: 'Futbol Ligi',
      shortName: 'Futbol',
      countryId: 'INT',
      icon: 'https://i.iddaa.com/i/iddaa/90/int.png',
      priority: 9999
    }

    live_state = extract_live_state(ev, sc_map, now_ts)
    live_count += 1 if live_state[:isLive]

    played_pct = played_pcts[ev['i'].to_s]
    prediction = build_prediction(ev, live_state, market_config, outcome_pcts, played_pct)

    formatted_markets = (ev['m'] || []).map do |m|
      k = "#{m['t']}_#{m['st']}"
      m_name = format_market_name(market_config.dig(k, 'n'), m['sov'])
      ev_m_pcts = outcome_pcts.dig(ev['i'].to_s, m['i'].to_s) || {}
      m_locked = (m['s'] && m['s'] != 1)
      {
        id: m['i'],
        code: k,
        name: m_name,
        sov: m['sov'],
        mbc: m['mbc'],
        locked: m_locked,
        outcomes: (m['o'] || []).map do |o|
          odd_f = o['odd'].to_f
          wodd_f = o['wodd'].to_f
          {
            no: o['no'],
            name: o['n'],
            odd: odd_f > 1.0 ? odd_f : nil,
            wodd: (wodd_f > 1.0 && wodd_f != odd_f) ? wodd_f : nil,
            locked: m_locked || odd_f <= 1.0,
            playPct: ev_m_pcts[o['no'].to_s]
          }
        end
      }
    end

    match_obj = {
      id: ev['i'],
      bri: ev['bri'],
      homeTeam: ev['hn'],
      awayTeam: ev['an'],
      sportId: sid,
      sportName: s_info[:name],
      sportSlug: s_info[:slug],
      sportIcon: s_info[:icon],
      competitionId: comp[:id],
      competitionName: comp[:name],
      competitionShort: comp[:shortName],
      countryId: comp[:countryId],
      competitionIcon: comp[:icon],
      competitionPriority: comp[:priority],
      timestamp: ts,
      date: date_key,
      time: time_str,
      isLive: live_state[:isLive],
      isStarted: live_state[:isStarted],
      isFinished: live_state[:isFinished],
      liveStatusText: live_state[:statusText],
      liveMinute: live_state[:minute],
      homeScore: live_state[:homeScore],
      awayScore: live_state[:awayScore],
      htScore: live_state[:htScore],
      homeRedCards: live_state[:homeRedCards],
      awayRedCards: live_state[:awayRedCards],
      homeCorners: live_state[:homeCorners],
      awayCorners: live_state[:awayCorners],
      liveAvailable: !!ev['il'],
      mbs: ev['mbc'] || 1,
      kingOdd: !!ev['kOdd'],
      totalOddsCount: ev['oc'] || formatted_markets.size,
      marketsCount: formatted_markets.size,
      playedPercentage: played_pct,
      prediction: prediction,
      markets: formatted_markets
    }

    all_matches << match_obj
    date_counts[date_key] += 1
  end

  all_matches.sort_by! { |m| [m[:timestamp], m[:competitionPriority], m[:id]] }

  now_tr_date = Time.now.getlocal('+03:00').strftime('%Y-%m-%d')
  tom_tr_date = (Time.now.getlocal('+03:00') + 86_400).strftime('%Y-%m-%d')
  dates_sorted = date_counts.keys.sort
  today_date = date_counts.key?(now_tr_date) ? now_tr_date : (dates_sorted[0] || now_tr_date)
  tomorrow_date = date_counts.key?(tom_tr_date) ? tom_tr_date : (dates_sorted[1] || tom_tr_date)

  summary = {
    generatedAt: Time.now.getlocal('+03:00').iso8601,
    source: 'iddaa.com (Futbol Bülteni & Canlı Skor)',
    totalMatches: all_matches.size,
    liveMatchesCount: live_count,
    todayDate: today_date,
    tomorrowDate: tomorrow_date,
    dateCounts: date_counts.sort.to_h
  }

  payload = {
    meta: summary,
    matches: all_matches
  }

  File.write(File.join(PUBLIC_DIR, 'matches_data.json'), JSON.generate(payload))
  File.write(File.join(PUBLIC_DIR, 'matches_data.js'), "window.IDDAA_DATA = #{JSON.generate(payload)};\n")
  puts "✅ Futbol bülteni ve canlı skor veritabanı oluşturuldu: #{all_matches.size} futbol maçı (#{live_count} canlı/başlamış)"
  summary
end

if __FILE__ == $PROGRAM_NAME
  sync_from_iddaa! if ARGV.include?('--sync')
  build_full_dataset!
end
