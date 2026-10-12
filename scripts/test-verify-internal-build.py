import os
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("verify-internal-build.sh")


class InternalBuildVerificationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.remote = root / "origin.git"
        self.output = root / "output"
        self.bin = root / "bin"
        self.bin.mkdir()
        mock = self.bin / "gh"
        mock.write_text(
            '#!/bin/sh\n'
            'case "$2" in\n'
            '  "repos/example/app/actions/workflows/ci.yml/runs?"*)\n'
            '    echo "${MOCK_CI_RESULT:-1}" ;;\n'
            '  *) echo "unexpected CI request" >&2; exit 1 ;;\n'
            "esac\n"
        )
        mock.chmod(0o700)
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.repo)], check=True)
        self.git("config", "user.name", "Release Test")
        self.git("config", "user.email", "release@example.invalid")
        (self.repo / "README").write_text("tested")
        self.git("add", "README")
        self.git("commit", "-qm", "tested")
        subprocess.run(["git", "clone", "-q", "--bare", str(self.repo), str(self.remote)], check=True)
        self.git("remote", "add", "origin", str(self.remote))

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()

    def verify(self, **overrides):
        env = dict(
            os.environ,
            GITHUB_REF="refs/heads/main",
            GITHUB_SHA=self.git("rev-parse", "HEAD"),
            GITHUB_ACTOR="barrelmaker97",
            GITHUB_TRIGGERING_ACTOR="barrelmaker97",
            GITHUB_RUN_NUMBER="1",
            GITHUB_OUTPUT=str(self.output),
            GITHUB_REPOSITORY="example/app",
            MOCK_CI_RESULT="1",
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
        )
        env.update(overrides)
        return subprocess.run(["bash", str(SCRIPT)], cwd=self.repo, env=env, capture_output=True, text=True)

    def test_tested_main_commit_has_unique_higher_build_number(self):
        result = self.verify()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("build_number=1001\n", self.output.read_text())
        self.assertIn(f"sha={self.git('rev-parse', 'HEAD')}\n", self.output.read_text())

    def test_rejects_other_branches_and_mismatched_commit(self):
        self.assertNotEqual(self.verify(GITHUB_REF="refs/heads/feature").returncode, 0)
        self.assertNotEqual(self.verify(GITHUB_SHA="0" * 40).returncode, 0)

    def test_rejects_unauthorized_initiator_and_rerun(self):
        self.assertNotEqual(self.verify(GITHUB_ACTOR="other").returncode, 0)
        self.assertNotEqual(self.verify(GITHUB_TRIGGERING_ACTOR="other").returncode, 0)
        self.assertEqual(self.verify(GITHUB_ACTOR="rhelsing", GITHUB_TRIGGERING_ACTOR="rhelsing").returncode, 0)

    def test_rejects_unverified_main(self):
        self.assertNotEqual(self.verify(MOCK_CI_RESULT="0").returncode, 0)

    def test_rejects_invalid_build_number(self):
        self.assertNotEqual(self.verify(GITHUB_RUN_NUMBER="0").returncode, 0)
        self.assertNotEqual(self.verify(GITHUB_RUN_NUMBER="2100000000").returncode, 0)

    def test_rejects_stale_main(self):
        (self.repo / "README").write_text("newer main")
        self.git("commit", "-qam", "new main")
        self.git("push", "-q", "origin", "main")
        self.git("switch", "-q", "--detach", "HEAD~1")
        self.assertNotEqual(self.verify().returncode, 0)


if __name__ == "__main__":
    unittest.main()
