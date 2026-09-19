"""Optional bridge for an already-fitted scikit-learn classifier, never fit during a cycle.

Import only in your application after installing scikit-learn. Do not load untrusted
pickle/joblib files. Persist the model and preprocessing fingerprint in your artifact.
"""

from loopiter import _validation as v
from loopiter import fingerprint


class FixedSklearnClassifier:
    def __init__(self, classifier, *, feature_names, model_version):
        # Optional scientific library stays outside core and is loaded only on explicit use.
        from sklearn.utils.validation import check_is_fitted

        check_is_fitted(classifier)
        v.nonempty(model_version, "model version")
        self.classifier = classifier
        self.feature_names = tuple(feature_names)
        self.model_version = model_version
        self.initial_fingerprint = self.fingerprint()

    def fingerprint(self):
        # This reference bridge supports linear classifiers; other models supply an adapter.
        return fingerprint(
            {
                "version": self.model_version,
                "features": list(self.feature_names),
                "classes": self.classifier.classes_.tolist(),
                "coefficients": self.classifier.coef_.tolist(),
                "intercept": self.classifier.intercept_.tolist(),
            }
        )

    async def predict(self, input_):
        if self.fingerprint() != self.initial_fingerprint:
            v.fail("model_changed", "Classifier weights/configuration changed during the cycle.")
        features = input_["features"]
        if set(features) != set(self.feature_names):
            v.fail("invalid_input", "Feature schema changed.")
        vector = [features[name] for name in self.feature_names]
        for value in vector:
            v.finite(value, "feature")
        probabilities = self.classifier.predict_proba([vector])[0]
        index = int(probabilities.argmax())
        return {
            "label": str(self.classifier.classes_[index]),
            "confidence": float(probabilities[index]),
        }
