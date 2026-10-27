from lung_engine import events


def test_commit_comes_from_LUNG_COMMIT_when_set(monkeypatch):  # the Space has no .git: its build writes the tag here
    monkeypatch.setenv("LUNG_COMMIT", "abc1234")
    assert events._commit() == "abc1234"


def test_commit_falls_back_to_git_without_LUNG_COMMIT(monkeypatch):
    monkeypatch.delenv("LUNG_COMMIT", raising=False)
    assert events._commit() != "abc1234"
