// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Append-only policy registry, reviewer panels with epoch rotation,
/// operational roles, and the Base outage ledger.
/// @dev Funded deals pin policy IDs, quorums, delays and reviewer epochs at
/// funding time, so later registrations or rotations can never rewrite an
/// existing deal's economics. New IDs only affect future deals.
contract MidmanPolicies {
    // ---- Roles ----
    address public governance;
    address public pauser;
    address public admissionSigner;
    address public treasury;
    address public sequencerFeed; // Chainlink Base sequencer uptime feed

    uint256 public constant ROTATION_DELAY = 72 hours;
    uint256 public constant UNPAUSE_DELAY = 24 hours;

    // Panel floor sizes for BOTH construction and rotation: a required
    // 5-member primary/fallback panel can never be rotated down to 3.
    uint8 internal constant MIN_PRIMARY = 5;
    uint8 internal constant MIN_FALLBACK = 5;
    uint8 internal constant MIN_VETO = 3;

    // ---- Policy records (append-only) ----
    struct FeePolicy {
        bool exists;
        bytes32 contentHash;
    }
    struct CategoryPolicy {
        bool exists;
        bytes32 contentHash;
        uint32 minInspectionSeconds;
    }
    struct ReadinessPolicy {
        bool exists;
        bytes32 contentHash;
        bool required;
    }
    struct EvidencePolicy {
        bool exists;
        bytes32 contentHash;
    }
    struct BondPolicy {
        bool exists;
        bytes32 contentHash;
        uint256 claimantBond;
        uint256 respondentBond;
    }
    struct ArbitrationPolicy {
        bool exists;
        bytes32 contentHash;
        uint8 tiersAllowed; // bitmask over tier indices 0..2
    }
    struct OutagePolicy {
        bool exists;
        bytes32 contentHash;
        uint32 gracePeriodSeconds;
        uint8 maxIntervals;
    }
    struct CatastrophicPolicy {
        bool exists;
        bytes32 contentHash;
    }

    mapping(bytes32 => FeePolicy) public feePolicies;
    mapping(bytes32 => CategoryPolicy) public categoryPolicies;
    mapping(bytes32 => ReadinessPolicy) public readinessPolicies;
    mapping(bytes32 => EvidencePolicy) public evidencePolicies;
    mapping(bytes32 => BondPolicy) public bondPolicies;
    mapping(bytes32 => ArbitrationPolicy) public arbitrationPolicies;
    mapping(bytes32 => OutagePolicy) public outagePolicies;
    mapping(bytes32 => CatastrophicPolicy) public catastrophicPolicies;

    // ---- Reviewer panels with epochs (P-07) ----
    uint64 public authEpoch;
    mapping(uint64 => address[]) public primaryPanel;
    mapping(uint64 => address[]) public fallbackPanel;
    mapping(uint64 => mapping(address => bool)) public isPrimary;
    mapping(uint64 => mapping(address => bool)) public isFallback;
    address[] public vetoPanel;
    mapping(address => bool) public isVeto;

    struct PendingPanel {
        address[] primaryPanel;
        address[] fallbackPanel;
        address[] vetoPanel;
        uint64 effectiveAt;
        bool active;
    }
    PendingPanel public pendingPanel;

    // ---- Generic timelocked address roles (admission, treasury, feed) ----
    struct PendingAddress {
        address value;
        uint64 effectiveAt;
        bool active;
    }
    PendingAddress public pendingAdmissionSigner;
    PendingAddress public pendingTreasury;
    PendingAddress public pendingFeed;

    // ---- Outage ledger (chain-global truth, P-09) ----
    // Append-only retained intervals with strictly absolute-age pruning and a
    // permanent dedupe set. There is NO capacity eviction: intervals are only
    // dropped once their end is older than MAX_HISTORY_AGE (comfortably longer
    // than the 60-day escape horizon), and `prunedBefore` records the maximum
    // dropped end so a clock anchored before it is reported UNKNOWN rather than
    // reconstructed with a shorter deadline. Beyond MAX_RETAINED the ledger is
    // flagged saturated and deadline math reports UNKNOWN.
    struct Outage {
        uint64 start;
        uint64 end;
    }
    Outage[] internal outageLedger;
    uint256 public outageTotal; // intervals ever accepted (monotone)
    uint64 public prunedBefore; // max end of any pruned interval (monotone)
    bool public outageSaturated; // retained count exceeded MAX_RETAINED
    mapping(bytes32 => bool) public outageSeen; // permanent dedupe over (start,end)
    uint256 public constant MAX_RETAINED = 256;
    uint256 public constant MAX_HISTORY_AGE = 180 days;

    // ---- History coverage watermark (completeness proof) ----
    // Chainlink uptime feeds mint a round on EVERY status transition (up->down
    // or down->up), so rounds are consecutive within a proxy phase. Proxy round
    // ids are `phaseId << 64 | aggregatorRound`, so an aggregator upgrade jumps
    // to the first round of the next phase; `successorRound` follows both.
    // `lastAuditedRound` is the highest feed round whose status has been
    // consumed into the ledger: seeded from the live head (construction and
    // feed rotation), then advanced only by reportOutage (the next round is a
    // down round, consumed with its recovery) or advanceWatermark (the next
    // round is an up round, carrying no downtime). An unreported transition
    // leaves the watermark behind the head, and deadline math reports history
    // UNKNOWN rather than a deadline computed from an incomplete ledger.
    uint80 public lastAuditedRound;

    // ---- Events ----
    event PolicyRegistered(bytes32 indexed policyId, bytes32 contentHash);
    event PanelProposed(uint64 effectiveAt);
    event PanelRotated(uint64 indexed epoch);
    event AddressProposed(bytes32 indexed role, address value, uint64 effectiveAt);
    event AddressRotated(bytes32 indexed role, address value);
    event OutageRecorded(uint64 start, uint64 end);
    event OutageAudited(uint80 indexed roundId);
    event GovernanceTransferred(address indexed next);

    error NotGovernance();
    error AlreadyRegistered();
    error BadPanel();
    error OutageTooOld();
    error NoPending();
    error TooEarly();
    error BadAddress();
    error WatermarkBehind();

    modifier onlyGovernance() {
        require(msg.sender == governance, NotGovernance());
        _;
    }

    constructor(
        address governance_,
        address pauser_,
        address admissionSigner_,
        address treasury_,
        address sequencerFeed_,
        address[] memory primary_,
        address[] memory fallback_,
        address[] memory veto_
    ) {
        require(governance_ != address(0) && treasury_ != address(0), BadAddress());
        _validatePanel(primary_, fallback_, veto_);
        governance = governance_;
        pauser = pauser_;
        admissionSigner = admissionSigner_;
        treasury = treasury_;
        sequencerFeed = sequencerFeed_;
        authEpoch = 1;
        _setPanel(1, primary_, fallback_, veto_);
        // All history before the head is irrelevant: every deal anchor is >=
        // deploy time.
        lastAuditedRound = _seedWatermark(sequencerFeed_);
    }

    /// @notice Coverage watermark for a feed's live head. A down head means the
    /// newest round is the ongoing outage; the prior round (its recovery
    /// boundary) is the last fully audited one.
    function _seedWatermark(address feed) internal view returns (uint80) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        require(ok && ret.length == 160, BadPanel());
        (uint80 rid, int256 ans, uint256 st,, uint80 air) =
            abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        require(rid != 0 && air == rid && st != 0 && st <= block.timestamp, BadPanel());
        return ans == 0 ? rid : rid - 1;
    }

    /// @notice Panel admission rules (P-05/P-15): a required 5-member primary
    /// and fallback panel (3-member veto), distinct members within each house
    /// (duplicates would silently raise the effective quorum or brick it), and
    /// pairwise-disjoint houses (a reviewer must never sit on two panels
    /// deciding the same deal). Applied identically at construction and
    /// rotation so a valid 5/5/3 panel can never be shrunk to 3.
    function _validatePanel(address[] memory primary_, address[] memory fallback_, address[] memory veto_)
        internal
        pure
    {
        require(
            primary_.length >= MIN_PRIMARY && fallback_.length >= MIN_FALLBACK && veto_.length >= MIN_VETO, BadPanel()
        );
        _distinct(primary_);
        _distinct(fallback_);
        _distinct(veto_);
        for (uint256 i = 0; i < primary_.length; i++) {
            require(primary_[i] != address(0), BadAddress());
            for (uint256 j = 0; j < fallback_.length; j++) require(primary_[i] != fallback_[j], BadPanel());
            for (uint256 j = 0; j < veto_.length; j++) require(primary_[i] != veto_[j], BadPanel());
        }
        for (uint256 i = 0; i < fallback_.length; i++) {
            require(fallback_[i] != address(0), BadAddress());
            for (uint256 j = 0; j < veto_.length; j++) require(fallback_[i] != veto_[j], BadPanel());
        }
        for (uint256 i = 0; i < veto_.length; i++) require(veto_[i] != address(0), BadAddress());
    }

    function _distinct(address[] memory panel) internal pure {
        for (uint256 i = 0; i < panel.length; i++) {
            for (uint256 j = i + 1; j < panel.length; j++) require(panel[i] != panel[j], BadPanel());
        }
    }

    function _setPanel(uint64 epoch, address[] memory primary_, address[] memory fallback_, address[] memory veto_)
        internal
    {
        for (uint256 i = 0; i < primary_.length; i++) {
            require(primary_[i] != address(0), BadAddress());
            isPrimary[epoch][primary_[i]] = true;
        }
        for (uint256 i = 0; i < fallback_.length; i++) {
            require(fallback_[i] != address(0), BadAddress());
            isFallback[epoch][fallback_[i]] = true;
        }
        delete vetoPanel;
        for (uint256 i = 0; i < veto_.length; i++) {
            require(veto_[i] != address(0), BadAddress());
            vetoPanel.push(veto_[i]);
            isVeto[veto_[i]] = true;
        }
        primaryPanel[epoch] = primary_;
        fallbackPanel[epoch] = fallback_;
    }

    // ---- Registration (governance, append-only) ----
    function registerFeePolicy(bytes32 id, bytes32 contentHash) external onlyGovernance {
        require(!feePolicies[id].exists, AlreadyRegistered());
        feePolicies[id] = FeePolicy({exists: true, contentHash: contentHash});
        emit PolicyRegistered(id, contentHash);
    }

    function registerCategoryPolicy(bytes32 id, bytes32 contentHash, uint32 minInspectionSeconds)
        external
        onlyGovernance
    {
        require(!categoryPolicies[id].exists, AlreadyRegistered());
        categoryPolicies[id] =
            CategoryPolicy({exists: true, contentHash: contentHash, minInspectionSeconds: minInspectionSeconds});
        emit PolicyRegistered(id, contentHash);
    }

    function registerReadinessPolicy(bytes32 id, bytes32 contentHash, bool required_) external onlyGovernance {
        require(!readinessPolicies[id].exists, AlreadyRegistered());
        readinessPolicies[id] = ReadinessPolicy({exists: true, contentHash: contentHash, required: required_});
        emit PolicyRegistered(id, contentHash);
    }

    function registerEvidencePolicy(bytes32 id, bytes32 contentHash) external onlyGovernance {
        require(!evidencePolicies[id].exists, AlreadyRegistered());
        evidencePolicies[id] = EvidencePolicy({exists: true, contentHash: contentHash});
        emit PolicyRegistered(id, contentHash);
    }

    function registerBondPolicy(bytes32 id, bytes32 contentHash, uint256 claimantBond, uint256 respondentBond)
        external
        onlyGovernance
    {
        require(!bondPolicies[id].exists, AlreadyRegistered());
        require(claimantBond >= 5_000_000 && respondentBond >= 5_000_000, BadPanel());
        bondPolicies[id] =
            BondPolicy({exists: true, contentHash: contentHash, claimantBond: claimantBond, respondentBond: respondentBond});
        emit PolicyRegistered(id, contentHash);
    }

    function registerArbitrationPolicy(bytes32 id, bytes32 contentHash, uint8 tiersAllowed)
        external
        onlyGovernance
    {
        require(!arbitrationPolicies[id].exists, AlreadyRegistered());
        require(tiersAllowed != 0, BadPanel());
        arbitrationPolicies[id] = ArbitrationPolicy({exists: true, contentHash: contentHash, tiersAllowed: tiersAllowed});
        emit PolicyRegistered(id, contentHash);
    }

    function registerOutagePolicy(bytes32 id, bytes32 contentHash, uint32 gracePeriodSeconds, uint8 maxIntervals)
        external
        onlyGovernance
    {
        require(!outagePolicies[id].exists, AlreadyRegistered());
        require(maxIntervals > 0 && maxIntervals <= 16, BadPanel());
        outagePolicies[id] =
            OutagePolicy({exists: true, contentHash: contentHash, gracePeriodSeconds: gracePeriodSeconds, maxIntervals: maxIntervals});
        emit PolicyRegistered(id, contentHash);
    }

    function registerCatastrophicPolicy(bytes32 id, bytes32 contentHash) external onlyGovernance {
        require(!catastrophicPolicies[id].exists, AlreadyRegistered());
        catastrophicPolicies[id] = CatastrophicPolicy({exists: true, contentHash: contentHash});
        emit PolicyRegistered(id, contentHash);
    }

    // ---- Panel rotation (72h timelock, epoch-gated) ----
    function proposePanel(address[] calldata primary_, address[] calldata fallback_, address[] calldata veto_)
        external
        onlyGovernance
    {
        _validatePanel(primary_, fallback_, veto_);
        delete pendingPanel.primaryPanel;
        delete pendingPanel.fallbackPanel;
        delete pendingPanel.vetoPanel;
        for (uint256 i = 0; i < primary_.length; i++) pendingPanel.primaryPanel.push(primary_[i]);
        for (uint256 i = 0; i < fallback_.length; i++) pendingPanel.fallbackPanel.push(fallback_[i]);
        for (uint256 i = 0; i < veto_.length; i++) pendingPanel.vetoPanel.push(veto_[i]);
        pendingPanel.effectiveAt = uint64(block.timestamp + ROTATION_DELAY);
        pendingPanel.active = true;
        emit PanelProposed(pendingPanel.effectiveAt);
    }

    function executePanel() external onlyGovernance {
        require(pendingPanel.active, NoPending());
        require(block.timestamp >= pendingPanel.effectiveAt, TooEarly());
        // Clear old veto flags.
        for (uint256 i = 0; i < vetoPanel.length; i++) isVeto[vetoPanel[i]] = false;
        authEpoch += 1;
        _setPanel(authEpoch, pendingPanel.primaryPanel, pendingPanel.fallbackPanel, pendingPanel.vetoPanel);
        pendingPanel.active = false;
        emit PanelRotated(authEpoch);
    }

    // ---- Timelocked address roles ----
    function _propose(PendingAddress storage slot, bytes32 role, address value) internal {
        require(value != address(0), BadAddress());
        slot.value = value;
        slot.effectiveAt = uint64(block.timestamp + ROTATION_DELAY);
        slot.active = true;
        emit AddressProposed(role, value, slot.effectiveAt);
    }

    function _execute(PendingAddress storage slot, bytes32 role, address current) internal returns (address) {
        require(slot.active, NoPending());
        require(block.timestamp >= slot.effectiveAt, TooEarly());
        slot.active = false;
        current = slot.value;
        emit AddressRotated(role, current);
        return current;
    }

    function proposeAdmissionSigner(address v) external onlyGovernance {
        _propose(pendingAdmissionSigner, "admission", v);
    }

    function executeAdmissionSigner() external onlyGovernance {
        admissionSigner = _execute(pendingAdmissionSigner, "admission", admissionSigner);
    }

    function proposeTreasury(address v) external onlyGovernance {
        _propose(pendingTreasury, "treasury", v);
    }

    function executeTreasury() external onlyGovernance {
        treasury = _execute(pendingTreasury, "treasury", treasury);
    }

    function proposeFeed(address v) external onlyGovernance {
        _propose(pendingFeed, "feed", v);
    }

    /// @notice Rotating the feed reseeds the watermark from the NEW feed's head
    /// (round ids are per-feed, so the old watermark is meaningless there).
    /// While the old feed is still readable, every transition on it must be
    /// audited first so its unreported outages are not silently dropped.
    function executeFeed() external onlyGovernance {
        (bool readable, bool covered) = _headCovered();
        require(!readable || covered, WatermarkBehind());
        sequencerFeed = _execute(pendingFeed, "feed", sequencerFeed);
        lastAuditedRound = _seedWatermark(sequencerFeed);
        emit OutageAudited(lastAuditedRound);
    }

    function transferGovernance(address next) external onlyGovernance {
        require(next != address(0), BadAddress());
        governance = next;
        emit GovernanceTransferred(next);
    }

    // ---- Outage ledger ----
    /// @notice Record a verified sequencer outage from a historical feed round.
    /// `roundId` must be a down round (answer 1) whose successor reports up
    /// (answer 0); interval is [down.startedAt, up.startedAt]. The feed round is
    /// validated deeply (round identity, round consistency, non-zero startedAt,
    /// updatedAt not in the future). Duplicates are rejected FOREVER by their
    /// exact (start,end) key, even after the interval is pruned. Intervals that
    /// ended before `block.timestamp - MAX_HISTORY_AGE` are rejected outright so
    /// a late historical report can never age out a live interval. Retained
    /// intervals older than MAX_HISTORY_AGE are pruned by absolute age only.
    function reportOutage(uint80 roundId) external {
        // Completeness: only the next un-audited transition may be consumed, so
        // a skipped/unreported outage leaves the watermark short of the head and
        // blocks deadline math instead of silently shortening a clock.
        (bool hasNext, uint80 expected) = successorRound(lastAuditedRound);
        require(hasNext && roundId == expected, BadPanel());
        uint64 s;
        uint64 e;
        uint80 recovery;
        {
            (bool okDown, int256 ans, uint256 st) = _roundView(roundId);
            require(okDown && ans == 1, BadPanel());
            bool hasRecovery;
            (hasRecovery, recovery) = successorRound(roundId);
            require(hasRecovery, BadPanel());
            (bool okUp, int256 ans2, uint256 st2) = _roundView(recovery);
            require(okUp && ans2 == 0 && st2 > st, BadPanel());
            s = uint64(st);
            e = uint64(st2);
        }
        bytes32 key = keccak256(abi.encode(s, e));
        require(!outageSeen[key], AlreadyRegistered());
        if (block.timestamp > MAX_HISTORY_AGE) {
            require(e >= uint64(block.timestamp - MAX_HISTORY_AGE), OutageTooOld());
        }
        outageSeen[key] = true;
        _pruneOld();
        outageLedger.push(Outage({start: s, end: e}));
        outageTotal += 1;
        if (outageLedger.length > MAX_RETAINED) outageSaturated = true;
        // Consume the down round AND its recovery, keeping the watermark in step
        // with the feed's round sequence.
        lastAuditedRound = recovery;
        emit OutageRecorded(s, e);
        emit OutageAudited(recovery);
    }

    /// @notice Consume the next un-audited round when it is an UP round. Up
    /// rounds carry no downtime, so this never shortens a clock; it is how the
    /// watermark crosses a proxy phase whose first round reports up.
    function advanceWatermark() external {
        (bool hasNext, uint80 next) = successorRound(lastAuditedRound);
        require(hasNext, NoPending());
        (, int256 ans,) = _roundView(next);
        require(ans == 0, BadPanel());
        lastAuditedRound = next;
        emit OutageAudited(next);
    }

    /// @notice The feed round after `rid`: `rid + 1` in the same proxy phase,
    /// else the first round of the next phase. exists=false at the head.
    function successorRound(uint80 rid) public view returns (bool exists, uint80 next) {
        (bool ok,,) = _roundView(rid + 1);
        if (ok) return (true, rid + 1);
        uint80 phase = rid >> 64;
        if (phase == type(uint16).max) return (false, 0);
        uint80 firstOfNext = ((phase + 1) << 64) | 1;
        (ok,,) = _roundView(firstOfNext);
        if (ok) return (true, firstOfNext);
        return (false, 0);
    }

    /// @notice True when every transition up to `head` is audited. An up head
    /// must be the watermark itself; a down head is the ongoing outage (covered
    /// by the live trailing interval) and needs only its predecessor audited.
    function watermarkCovers(uint80 head, bool headUp) public view returns (bool) {
        uint80 la = lastAuditedRound;
        if (headUp) return la == head;
        if (la >= head) return true;
        (bool hasNext, uint80 next) = successorRound(la);
        return hasNext && next == head;
    }

    /// @notice Coverage of the configured feed's live head; readable=false when
    /// the latest round is malformed.
    function _headCovered() internal view returns (bool readable, bool covered) {
        (bool ok, bytes memory ret) = sequencerFeed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        if (!ok || ret.length != 160) return (false, false);
        (uint80 rid, int256 ans,,, uint80 air) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        if (rid == 0 || air != rid) return (false, false);
        return (true, watermarkCovers(rid, ans == 0));
    }

    /// @notice Strictly validated historical round; ok=false for a missing,
    /// reverted, inconsistent or future-dated round.
    function _roundView(uint80 rid) internal view returns (bool ok, int256 ans, uint256 startedAt) {
        (bool success, bytes memory ret) =
            sequencerFeed.staticcall(abi.encodeWithSignature("getRoundData(uint80)", rid));
        if (!success || ret.length != 160) return (false, 0, 0);
        (uint80 r, int256 a, uint256 st, uint256 upd, uint80 air) =
            abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        if (r != rid || air != rid || st == 0 || st > block.timestamp) return (false, 0, 0);
        if (upd == 0 || upd > block.timestamp || (a != 0 && a != 1)) return (false, 0, 0);
        return (true, a, st);
    }

    /// @notice Compact retained intervals: drop any whose end is strictly older
    /// than MAX_HISTORY_AGE, advancing `prunedBefore` to the max dropped end.
    function _pruneOld() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs <= MAX_HISTORY_AGE) return;
        uint64 threshold = uint64(nowTs - MAX_HISTORY_AGE);
        uint256 len = outageLedger.length;
        uint256 write = 0;
        uint64 newPruned = prunedBefore;
        for (uint256 i = 0; i < len; i++) {
            Outage memory o = outageLedger[i];
            if (o.end < threshold) {
                if (o.end > newPruned) newPruned = o.end;
            } else {
                if (write != i) outageLedger[write] = o;
                write++;
            }
        }
        if (write != len) {
            for (uint256 j = len; j > write; j--) outageLedger.pop();
            prunedBefore = newPruned;
        }
    }

    function outageCount() external view returns (uint256) {
        return outageLedger.length;
    }

    /// @notice i-th retained interval (indexer-compatible access).
    function outageAt(uint256 i) public view returns (uint64 start, uint64 end) {
        require(i < outageLedger.length, BadPanel());
        Outage storage o = outageLedger[i];
        return (o.start, o.end);
    }

    /// @notice Legacy alias for the i-th retained interval.
    function outages(uint256 i) external view returns (uint64 start, uint64 end) {
        return outageAt(i);
    }
}
