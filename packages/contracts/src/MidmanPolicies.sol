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
    // Ring buffer: reporting never bricks at capacity; the oldest interval is
    // evicted. Deadline math always reads the MOST RECENT entries, which are
    // the only ones that can intersect a live deal's clocks.
    struct Outage {
        uint64 start;
        uint64 end;
    }
    mapping(uint256 => Outage) private outageSlots;
    uint256 public outageTotal; // intervals ever recorded (monotone)
    uint256 public constant MAX_OUTAGES = 64;

    // ---- Events ----
    event PolicyRegistered(bytes32 indexed policyId, bytes32 contentHash);
    event PanelProposed(uint64 effectiveAt);
    event PanelRotated(uint64 indexed epoch);
    event AddressProposed(bytes32 indexed role, address value, uint64 effectiveAt);
    event AddressRotated(bytes32 indexed role, address value);
    event OutageRecorded(uint64 start, uint64 end);
    event GovernanceTransferred(address indexed next);

    error NotGovernance();
    error AlreadyRegistered();
    error BadPanel();
    error NoPending();
    error TooEarly();
    error BadAddress();

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
    }

    /// @notice Panel admission rules (P-05/P-15): minimum sizes matching the
    /// tier quorum table (hub quorums are 2 or 3, so 3 distinct members is the
    /// floor), distinct members within each house (duplicates would silently
    /// raise the effective quorum or brick it), and pairwise-disjoint houses
    /// (a reviewer must never sit on two panels deciding the same deal).
    function _validatePanel(address[] memory primary_, address[] memory fallback_, address[] memory veto_)
        internal
        pure
    {
        require(primary_.length >= 3 && fallback_.length >= 3 && veto_.length >= 3, BadPanel());
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

    function executeFeed() external onlyGovernance {
        sequencerFeed = _execute(pendingFeed, "feed", sequencerFeed);
    }

    function transferGovernance(address next) external onlyGovernance {
        require(next != address(0), BadAddress());
        governance = next;
        emit GovernanceTransferred(next);
    }

    // ---- Outage ledger ----
    /// @notice Record a verified sequencer outage from a historical feed round.
    /// `roundId` must be a round reporting down (answer 1) whose successor
    /// reports up (answer 0). Interval is [down.startedAt, up.startedAt].
    /// Beyond capacity the oldest retained interval is evicted (ring write).
    function reportOutage(uint80 roundId) external {
        (uint80 rid, int256 answer, uint256 startedAt,,) = _roundData(roundId);
        require(rid == roundId && answer == 1, BadPanel());
        (, int256 nextAnswer, uint256 nextStartedAt,,) = _roundData(roundId + 1);
        require(nextAnswer == 0 && nextStartedAt > startedAt, BadPanel());
        require(nextStartedAt <= block.timestamp, BadPanel());
        uint64 s = uint64(startedAt);
        uint64 e = uint64(nextStartedAt);
        uint256 retained = outageRetained();
        for (uint256 k = 0; k < retained; k++) {
            (uint64 rs, uint64 re) = outageRecent(k);
            require(rs != s || re != e, AlreadyRegistered());
        }
        outageSlots[outageTotal % MAX_OUTAGES] = Outage({start: s, end: e});
        outageTotal += 1;
        emit OutageRecorded(s, e);
    }

    function _roundData(uint80 roundId)
        internal
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        (bool ok, bytes memory ret) = sequencerFeed.staticcall(
            abi.encodeWithSignature("getRoundData(uint80)", roundId)
        );
        require(ok && ret.length == 160, BadPanel());
        return abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
    }

    function outageCount() external view returns (uint256) {
        return outageRetained();
    }

    /// @notice Intervals currently retained (at most MAX_OUTAGES).
    function outageRetained() public view returns (uint256) {
        return outageTotal > MAX_OUTAGES ? MAX_OUTAGES : outageTotal;
    }

    /// @notice i-th oldest RETAINED interval (indexer-compatible access).
    function outages(uint256 i) external view returns (uint64 start, uint64 end) {
        uint256 retained = outageRetained();
        require(i < retained, BadPanel());
        Outage storage o = outageSlots[(outageTotal - retained + i) % MAX_OUTAGES];
        return (o.start, o.end);
    }

    /// @notice k-th MOST RECENT interval (k=0 is newest). Used by deadline math.
    function outageRecent(uint256 k) public view returns (uint64 start, uint64 end) {
        require(k < outageRetained(), BadPanel());
        Outage storage o = outageSlots[(outageTotal - 1 - k) % MAX_OUTAGES];
        return (o.start, o.end);
    }
}
