const QuantstampAudit = artifacts.require('QuantstampAudit');
const QuantstampAuditData = artifacts.require('QuantstampAuditData');
const QuantstampAuditView = artifacts.require('QuantstampAuditView');
const QuantstampToken = artifacts.require('QuantstampToken');
const Util = require("./util.js");
const AuditState = Util.AuditState;


contract('QuantstampAudit', function(accounts) {
  const owner = accounts[0];
  const admin = accounts[1];
  const requestor = accounts[2];
  const auditor = accounts[3];
  const price = 123;
  const requestorBudget = Util.toQsp(100000);

  let requestCounter = 1;
  let quantstamp_audit;
  let quantstamp_audit_data;
  let quantstamp_audit_view;
  let quantstamp_token;

  beforeEach(async function () {
    quantstamp_audit = await QuantstampAudit.deployed();
    quantstamp_audit_data = await QuantstampAuditData.deployed();
    quantstamp_audit_view = await QuantstampAuditView.deployed();
    quantstamp_token = await QuantstampToken.deployed();

    await quantstamp_audit_data.addAddressToWhitelist(quantstamp_audit.address);
    // enable transfers before any payments are allowed
    await quantstamp_token.enableTransfer({from : owner});
    // transfer 100,000 QSP tokens to the requestor
    await quantstamp_token.transfer(requestor, requestorBudget, {from : owner});
    // allow the audit contract use up to 65QSP for audits
    await quantstamp_token.approve(quantstamp_audit.address, Util.toQsp(1000), {from : requestor});
    // whitelisting auditor
    await quantstamp_audit_data.addNodeToWhitelist(auditor);
    // relaxing the requirement for other tests
    await quantstamp_audit_data.setMaxAssignedRequests(100);
  });

  it("queues new audits and assigns them in the right order", async function() {
    const requestId1 = requestCounter++;
    const requestId2 = requestCounter++;
    const requestId3 = requestCounter++;


    assert(await quantstamp_audit_view.getQueueLength.call(), 0);
    Util.assertEvent({
        result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditQueueIsEmpty",
      args: (args) => {}
    });

    Util.assertEvent({
      result: await quantstamp_audit.requestAudit(Util.uri, price, {from:requestor}),
      name: "LogAuditRequested",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId1);
      }
    });

    assert(await quantstamp_audit_view.getQueueLength.call(), 1);

    Util.assertEvent({
      result: await quantstamp_audit.requestAudit(Util.uri, price, {from:requestor}),
      name: "LogAuditRequested",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId2);
      }
    });


    assert(await quantstamp_audit_view.getQueueLength.call(), 2);
    Util.assertEvent({
      result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditAssigned",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId1);
        assert.equal(args.auditor, auditor);
      }
    });

    assert(await quantstamp_audit_view.getQueueLength.call(), 1);
    Util.assertEvent({
      result: await quantstamp_audit.requestAudit(Util.uri, price, {from:requestor}),
      name: "LogAuditRequested",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId3);
      }
    });

    assert(await quantstamp_audit_view.getQueueLength.call(), 2);
    Util.assertEvent({
      result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditAssigned",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId2);
        assert.equal(args.auditor, auditor);
      }
    });


    assert(await quantstamp_audit_view.getQueueLength.call(), 1);
    Util.assertEvent({
      result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditAssigned",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId3);
        assert.equal(args.auditor, auditor);
      }
    });

    assert(await quantstamp_audit_view.getQueueLength.call(), 0);
    Util.assertEvent({
      result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditQueueIsEmpty",
      args: (args) => {}
    });
  });

  it("submits a report when audit is queued and auditor is correct", async function() {
    const requestId = requestCounter++;
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    await quantstamp_audit.getNextAuditRequest({from: auditor});

    const result = await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor});
    Util.assertEventAtIndex({
      result: result,
      name: "LogAuditFinished",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId);
        assert.equal(args.auditor, auditor);
        assert.equal(args.auditResult, AuditState.Completed);
        assert.equal(args.reportUri, Util.reportUri);
        assert.equal(args.reportHash, Util.sha256emptyFile);
      },
      index: 0
    });

    Util.assertEventAtIndex({
      result: result,
      name: "LogPayAuditor",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId);
        assert.equal(args.auditor, auditor);
        assert.equal(args.amount, price);
      },
      index: 1
    });
  });

  it("does not submit a report when already audited", async function() {
    const requestId = requestCounter++;
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    await quantstamp_audit.getNextAuditRequest({from: auditor});
    await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor});
    const state = await quantstamp_audit_data.getAuditState(requestId);
    assert.equal(state, AuditState.Completed);
    Util.assertEvent({
      result: await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor}),
      name: "LogReportSubmissionError_InvalidState",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId);
        assert.equal(args.state, AuditState.Completed);
      }
    });
  });

  it("does not assign an audit when the queue is empty", async function() {
    Util.assertEvent({
      result: await quantstamp_audit.getNextAuditRequest({from: auditor}),
      name: "LogAuditQueueIsEmpty",
      args: (args) => {}
    });
  });

  it("getQueueLength() returns queue length", async function() {
    const length = await quantstamp_audit_view.getQueueLength.call();
    assert.equal(length.toNumber(), 0); // queue should be empty by the end of each test
  });

  it("should prevent not-whitelisted auditor to get next audit request", async function() {
    const auditor = accounts[4];
    const requestId = requestCounter++;

    // for the sake of dependency, let's ensure the auditor is not in the whitelist
    await quantstamp_audit_data.removeNodeFromWhitelist(auditor);

    Util.assertTxFail(quantstamp_audit.getNextAuditRequest({from: auditor}));
  });

  it("should prevent not-whitelisted auditor to submit a report", async function() {
    const auditor = accounts[4];
    const requestId = requestCounter++;

    // for the sake of dependency, let's ensure the auditor is not in the whitelist
    await quantstamp_audit_data.removeNodeFromWhitelist(auditor);

    Util.assertTxFail(quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor}));
  });

  it("should prevent a whitelisted user from submitting a report to an audit that they are not assigned", async function() {
    const auditor2 = accounts[4];
    await quantstamp_audit_data.addNodeToWhitelist(auditor);
    await quantstamp_audit_data.addNodeToWhitelist(auditor2);
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    const result = await quantstamp_audit.getNextAuditRequest({from: auditor});
    const requestId = Util.extractRequestId(result);

    Util.assertEvent({
      result: await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor2}),
      name: "LogReportSubmissionError_InvalidAuditor",
      args: (args) => {
        assert.equal(args.requestId.toNumber(), requestId);
        assert.equal(args.auditor, auditor2);
      }
    });

    await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor});
    // for the sake of dependency, let's ensure the auditor is not in the whitelist
    await quantstamp_audit_data.removeNodeFromWhitelist(auditor2);
  });

  it("should prevent an audit from being submitted with a bad state", async function() {
    const auditor2 = accounts[4];
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    const result = await quantstamp_audit.getNextAuditRequest({from: auditor});
    const requestId = Util.extractRequestId(result);

    Util.assertTxFail(quantstamp_audit.submitReport(requestId, AuditState.None, Util.reportUri, Util.sha256emptyFile, {from: auditor}));
    Util.assertTxFail(quantstamp_audit.submitReport(requestId, AuditState.Queued, Util.reportUri, Util.sha256emptyFile, {from: auditor}));
    Util.assertTxFail(quantstamp_audit.submitReport(requestId, AuditState.Assigned, Util.reportUri, Util.sha256emptyFile, {from: auditor}));
    Util.assertTxFail(quantstamp_audit.submitReport(requestId, AuditState.Refunded, Util.reportUri, Util.sha256emptyFile, {from: auditor}));


    await quantstamp_audit.submitReport(requestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor});
  });

  it("should prevent a requestor to request an audit if owner paused", async function() {
    // for the sake of dependency, let's ensure the auditor is not in the whitelist
    await quantstamp_audit.pause();

    Util.assertTxFail(quantstamp_audit.requestAudit(Util.uri, price, {from: requestor}));
    await quantstamp_audit.unpause();
  });

  it("does not get another request before finishes the previous one", async function() {
    const auditor2 = accounts[4];
    const pendingAuditsNum = (await quantstamp_audit.assignedRequestIds.call(auditor2)).toNumber();

    await quantstamp_audit_data.setMaxAssignedRequests(pendingAuditsNum + 1);
    await quantstamp_audit_data.addNodeToWhitelist(auditor2);

    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});

    await quantstamp_audit.getNextAuditRequest({from: auditor2});

    Util.assertEvent({
        result: await quantstamp_audit.getNextAuditRequest({from: auditor2}),
        name: "LogAuditAssignmentError_ExceededMaxAssignedRequests",
        args: (args) => {
        assert.equal(args.auditor, auditor2);
      }
    });
  });

  it("should get a request after finishing the previous one", async function() {
    const auditor2 = accounts[4];

    await quantstamp_audit_data.addNodeToWhitelist(auditor2);
    const pendingAuditsNum = (await quantstamp_audit.assignedRequestIds.call(auditor2)).toNumber();
    await quantstamp_audit_data.setMaxAssignedRequests(pendingAuditsNum + 1);

    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});

    const result = await quantstamp_audit.getNextAuditRequest({from: auditor2});

    Util.assertEvent({
        result: result,
        name: "LogAuditAssigned",
        args: (args) => {}
    });

    const grantedRequestId = result.logs[0].args.requestId.toNumber();
    await quantstamp_audit.submitReport(grantedRequestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor2});

    Util.assertEvent({
        result: await quantstamp_audit.getNextAuditRequest({from: auditor2}),
        name: "LogAuditAssigned",
        args: (args) => {}
    });

  });

  it("does not get another request before finishing the previous one even if it submitted a report before", async function() {
    const auditor2 = accounts[4];

    await quantstamp_audit_data.addNodeToWhitelist(auditor2);
    const pendingAuditsNum = (await quantstamp_audit.assignedRequestIds.call(auditor2)).toNumber();
    await quantstamp_audit_data.setMaxAssignedRequests(pendingAuditsNum + 1);

    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    const result = await quantstamp_audit.getNextAuditRequest({from: auditor2});

    Util.assertEvent({
      result: result,
      name: "LogAuditAssigned",
      args: (args) => {}
    });

    const grantedRequestId = result.logs[0].args.requestId.toNumber();
    await quantstamp_audit.submitReport(grantedRequestId, AuditState.Completed, Util.reportUri, Util.sha256emptyFile, {from: auditor2});

    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});
    await quantstamp_audit.requestAudit(Util.uri, price, {from: requestor});

    await quantstamp_audit.getNextAuditRequest({from: auditor2});

    Util.assertEvent({
        result: await quantstamp_audit.getNextAuditRequest({from: auditor2}),
        name: "LogAuditAssignmentError_ExceededMaxAssignedRequests",
        args: (args) => {
        assert.equal(args.auditor, auditor2);
      }
    });
  });

  it("should not let ask for request with zero price", async function() {
    Util.assertTxFail(quantstamp_audit.requestAudit(Util.uri, 0, {from: requestor}));
  });

});
